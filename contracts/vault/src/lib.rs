//! Lusty Vault — trustless covered-call vault (Soroban, v2).
//!
//! v2 closes the full money loop on-chain. All three legs of a covered call
//! are now contract-enforced:
//!
//!   1. ESCROW: collateral (XLM) is held by this contract — nobody, including
//!      the protocol, can move it except through `settle()`.
//!   2. PREMIUM: paid to the writer in cash (USDC) from the contract's pool
//!      ATOMICALLY inside `deposit()` — no separate server payout to trust.
//!      The premium amount is the protocol's signed offer: `deposit` requires
//!      auth from both the writer AND the quoter (the pricing engine's key),
//!      the on-chain equivalent of an RFQ. Custody and settlement never
//!      depend on the quoter.
//!   3. SETTLEMENT: decided by the Reflector price AT EXPIRY, permissionless.
//!      Assigned positions now follow real covered-call economics: the writer
//!      receives the strike value in cash, the collateral goes to the
//!      treasury. Kept positions return the collateral whole.
//!
//! Positions carry a `Kind` so the same escrow/settlement machinery can back
//! cash-secured puts alongside covered calls: the two differ only in which
//! token the writer escrows and which side of the strike assigns.
//!
//! Remaining: position tokens, upgrade governance, automated pool solvency
//! management (today: ops funds the pool via `fund`).

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, Env, Symbol,
};

/// Reflector oracle interface (https://github.com/reflector-network/reflector-contract).
/// Cross-contract compatibility is structural: variant/field names must match
/// the deployed oracle's XDR exactly (`Stellar`/`Other`, `price`/`timestamp`).
pub mod reflector {
    use soroban_sdk::{contractclient, contracttype, Address, Env, Symbol};

    #[contracttype]
    #[derive(Clone)]
    pub enum Asset {
        /// Stellar Classic or Soroban asset, addressed by its contract.
        Stellar(Address),
        /// External symbol (CEX/DEX feeds) — e.g. `Other(Symbol::new("XLM"))`.
        Other(Symbol),
    }

    #[contracttype]
    #[derive(Clone)]
    pub struct PriceData {
        /// Price scaled by 10^decimals() (Reflector feeds use 14 decimals).
        pub price: i128,
        /// Unix seconds, normalized to the feed resolution.
        pub timestamp: u64,
    }

    #[contractclient(name = "ReflectorClient")]
    pub trait Contract {
        fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
        fn price(env: Env, asset: Asset, timestamp: u64) -> Option<PriceData>;
        fn decimals(env: Env) -> u32;
        fn resolution(env: Env) -> u32;
    }
}

use reflector::ReflectorClient;

/// Reject a `lastprice` fallback older than this (seconds). A stale oracle
/// must block settlement (fail-closed), not settle at a wrong price.
const MAX_PRICE_STALENESS_SECS: u64 = 3600;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidAmount = 1,
    InvalidStrike = 2,
    InvalidExpiry = 3,
    PositionNotFound = 4,
    AlreadySettled = 5,
    NotExpired = 6,
    NoPrice = 7,
    StalePrice = 8,
    InvalidPremium = 9,
    InsufficientPool = 10,
    PositionTooLarge = 11,
    InvalidLimit = 12,
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    /// Reflector oracle contract this vault settles against.
    pub oracle: Address,
    /// Feed symbol queried as `Asset::Other(feed)` — e.g. "XLM".
    pub feed: Symbol,
    /// Underlying token (SAC address; native XLM SAC). Collateral for covered
    /// calls, the asset a cash-secured put agrees to buy.
    pub token: Address,
    /// Cash token (USDC SAC) — premiums out, assignment payouts out, and the
    /// collateral a cash-secured put escrows.
    pub cash: Address,
    /// Receives assigned collateral (T3: automated solvency management).
    pub treasury: Address,
    /// Pricing-engine key that must co-sign every deposit's premium (RFQ).
    pub quoter: Address,
    /// Sets the risk limits. Custody and settlement never route through it:
    /// the admin cannot move collateral, price an option or settle a position.
    /// T2 moves this key to a multisig account.
    pub admin: Address,
}

/// Risk limits the contract enforces itself, rather than trusting the caller
/// to have checked them. Stored apart from `Config` because these are the only
/// values the admin can change.
#[contracttype]
#[derive(Clone)]
pub struct Limits {
    /// Largest single position, in the kind's own collateral units:
    /// underlying for a call, cash for a put.
    pub max_position_call: i128,
    pub max_position_put: i128,
}

impl Limits {
    fn max_position(&self, kind: Kind) -> i128 {
        match kind {
            Kind::Call => self.max_position_call,
            Kind::Put => self.max_position_put,
        }
    }
}

/// Which option the writer is selling. Both legs share the escrow, premium and
/// oracle-settlement machinery; they differ only in the token escrowed and the
/// side of the strike that assigns.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    /// Covered call: escrow the underlying, assign above the strike.
    Call = 0,
    /// Cash-secured put: escrow the strike value in cash, assign below it.
    Put = 1,
}

impl Kind {
    /// The token the writer escrows to back this option. A call writer already
    /// holds the asset; a put writer sets aside the cash to buy it with.
    fn collateral<'a>(&self, cfg: &'a Config) -> &'a Address {
        match self {
            Kind::Call => &cfg.token,
            Kind::Put => &cfg.cash,
        }
    }

    /// The token the vault pays out when this option assigns — always the leg
    /// the writer did not escrow, and so always the token the OTHER kind
    /// escrows. That symmetry is what makes the two pools separable.
    fn payout<'a>(&self, cfg: &'a Config) -> &'a Address {
        match self {
            Kind::Call => &cfg.cash,
            Kind::Put => &cfg.token,
        }
    }

    fn opposite(&self) -> Kind {
        match self {
            Kind::Call => Kind::Put,
            Kind::Put => Kind::Call,
        }
    }
}

#[contracttype]
#[derive(Clone)]
pub struct Position {
    pub owner: Address,
    /// Covered call or cash-secured put — selects the collateral token and the
    /// assignment direction at settlement.
    pub kind: Kind,
    /// Collateral escrowed, in the collateral token's stroops/units.
    pub amount: i128,
    /// Strike scaled by 10^oracle.decimals() — same scale as PriceData.price.
    pub strike: i128,
    /// Unix seconds. Settlement uses the oracle price AT this timestamp.
    pub expiry: u64,
    /// Cash premium paid to the writer at deposit (cash token units).
    pub premium: i128,
    pub settled: bool,
    /// "open" | "kept" | "assigned"
    pub outcome: Symbol,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    NextId,
    Position(u64),
    /// Collateral currently escrowed for OPEN positions of this kind. Puts
    /// escrow the same token the premium pool is denominated in, so the pool's
    /// free balance is `balance - escrowed(Put)` — never the raw balance.
    Escrowed(Kind),
    /// What the vault would owe if every open position of this kind assigned.
    /// Denominated in the payout token, which is the OTHER leg's collateral:
    /// calls owe cash, puts owe the underlying.
    Owed(Kind),
    Limits,
}

#[contract]
pub struct LustyVault;

#[contractimpl]
impl LustyVault {
    pub fn __constructor(
        env: Env,
        oracle: Address,
        feed: Symbol,
        token: Address,
        cash: Address,
        treasury: Address,
        quoter: Address,
        admin: Address,
        limits: Limits,
    ) {
        env.storage().instance().set(
            &DataKey::Config,
            &Config { oracle, feed, token, cash, treasury, quoter, admin },
        );
        Self::store_limits(&env, &limits);
        env.storage().instance().set(&DataKey::NextId, &0u64);
    }

    /// Adjust the risk limits. Admin-only, and deliberately the admin's ONLY
    /// power: it can shrink what the vault accepts, never reach the collateral
    /// already escrowed under the old limits.
    pub fn set_limits(env: Env, limits: Limits) {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        cfg.admin.require_auth();
        Self::store_limits(&env, &limits);
        env.events().publish(
            (symbol_short!("limits"),),
            (limits.max_position_call, limits.max_position_put),
        );
    }

    pub fn limits(env: Env) -> Limits {
        env.storage().instance().get(&DataKey::Limits).unwrap()
    }

    /// Top up the cash pool: premiums for both legs, plus the strike value a
    /// call assignment pays out. Permissionless — anyone may add solvency,
    /// nobody can take it out except through settlement.
    pub fn fund(env: Env, from: Address, amount: i128) {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        Self::fund_pool(&env, &cfg.cash, symbol_short!("cash"), from, amount);
    }

    /// Top up the underlying pool, which delivers the asset a put assignment
    /// buys at the strike. Distinct from `fund` because the two payouts draw
    /// on different tokens.
    ///
    /// The vault's underlying balance also holds every open call's escrowed
    /// collateral, so the deliverable inventory is `balance - escrowed(Call)`.
    /// Opening a put reserves against that free balance; see `write`.
    pub fn fund_underlying(env: Env, from: Address, amount: i128) {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        Self::fund_pool(&env, &cfg.token, symbol_short!("under"), from, amount);
    }

    /// Write a covered call. Thin wrapper over [`Self::open`] kept so existing
    /// clients and the deployed CLI recipes keep working unchanged.
    pub fn deposit(
        env: Env,
        owner: Address,
        amount: i128,
        strike: i128,
        expiry: u64,
        premium: i128,
    ) -> u64 {
        Self::write(env, owner, Kind::Call, amount, strike, expiry, premium)
    }

    /// Write an option of either kind: escrow `amount` collateral at `strike`
    /// until `expiry`, receiving `premium` cash instantly from the pool — one
    /// atomic transaction. The writer authorizes the collateral transfer; the
    /// quoter (pricing engine) co-signs the premium figure, so neither side
    /// can set the price alone. If the pool cannot cover the premium the
    /// deposit fails whole (fail-closed).
    ///
    /// `amount` is always the COLLATERAL, in the escrowed token's units:
    ///   Call → the underlying itself; the writer covers 1 unit per unit.
    ///   Put  → cash; it secures `amount × 10^dec / strike` units of the
    ///          underlying, the quantity the writer commits to buy at strike.
    pub fn open(
        env: Env,
        owner: Address,
        kind: Kind,
        amount: i128,
        strike: i128,
        expiry: u64,
        premium: i128,
    ) -> u64 {
        Self::write(env, owner, kind, amount, strike, expiry, premium)
    }

    /// Collateral currently escrowed for open positions of `kind`. Public so
    /// the split between escrowed collateral and free pool is verifiable from
    /// contract state rather than inferred from the raw token balance.
    pub fn escrowed(env: Env, kind: Kind) -> i128 {
        Self::escrow_of(&env, kind)
    }

    /// What the vault would pay out if every open position of `kind` assigned,
    /// in that kind's payout token. Read alongside `escrowed` to check the
    /// vault's solvency from outside, exactly as the contract checks it.
    pub fn owed(env: Env, kind: Kind) -> i128 {
        Self::owed_of(&env, kind)
    }

    /// Settle an expired position against the oracle price AT EXPIRY.
    /// Permissionless: anyone may trigger it (the outcome is deterministic),
    /// so the writer does not depend on the protocol being online.
    ///
    ///   price(expiry) >  strike → assigned: collateral to the treasury,
    ///                             strike value paid to the writer in cash —
    ///                             economically identical to selling the
    ///                             collateral at the strike, as a covered
    ///                             call settles.
    ///   price(expiry) <= strike → kept: collateral returned to the writer.
    pub fn settle(env: Env, id: u64) -> Symbol {
        let key = DataKey::Position(id);
        let mut pos: Position = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::PositionNotFound));
        if pos.settled {
            panic_with_error!(&env, Error::AlreadySettled);
        }
        let now = env.ledger().timestamp();
        if now < pos.expiry {
            panic_with_error!(&env, Error::NotExpired);
        }

        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        let oracle = ReflectorClient::new(&env, &cfg.oracle);
        let price = Self::settlement_price(&env, &oracle, &cfg, pos.expiry, now);

        let this = env.current_contract_address();
        let collateral = pos.kind.collateral(&cfg).clone();
        let scale = 10i128.pow(oracle.decimals());
        // Assignment is the writer's obligation coming due: a call is exercised
        // above the strike, a put below it. Equality is out-of-the-money for
        // both, matching the off-chain vault's rule.
        let assigned = match pos.kind {
            Kind::Call => price > pos.strike,
            Kind::Put => price < pos.strike,
        };

        let owed = Self::obligation(&env, pos.kind, pos.amount, pos.strike, scale);
        let outcome = if assigned {
            // The escrowed collateral is what the writer gives up; the other
            // leg of the trade is paid out of the vault's pool.
            token::Client::new(&env, &collateral).transfer(&this, &cfg.treasury, &pos.amount);
            if owed > 0 {
                token::Client::new(&env, pos.kind.payout(&cfg)).transfer(&this, &pos.owner, &owed);
            }
            symbol_short!("assigned")
        } else {
            token::Client::new(&env, &collateral).transfer(&this, &pos.owner, &pos.amount);
            symbol_short!("kept")
        };
        // The position is closed either way: its collateral has left the vault
        // and its contingent payout is no longer owed.
        Self::add_escrow(&env, pos.kind, -pos.amount);
        Self::add_owed(&env, pos.kind, -owed);

        pos.settled = true;
        pos.outcome = outcome.clone();
        env.storage().persistent().set(&key, &pos);

        env.events()
            .publish((symbol_short!("settle"), id), (outcome.clone(), price));
        outcome
    }

    pub fn position(env: Env, id: u64) -> Position {
        env.storage()
            .persistent()
            .get(&DataKey::Position(id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::PositionNotFound))
    }

    pub fn config(env: Env) -> Config {
        env.storage().instance().get(&DataKey::Config).unwrap()
    }

    /// Shared escrow-and-price path behind `deposit`/`open`.
    fn write(
        env: Env,
        owner: Address,
        kind: Kind,
        amount: i128,
        strike: i128,
        expiry: u64,
        premium: i128,
    ) -> u64 {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        owner.require_auth();
        cfg.quoter.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if strike <= 0 {
            panic_with_error!(&env, Error::InvalidStrike);
        }
        if expiry <= env.ledger().timestamp() {
            panic_with_error!(&env, Error::InvalidExpiry);
        }
        if premium < 0 {
            panic_with_error!(&env, Error::InvalidPremium);
        }
        // Size cap: one writer must not be able to put the whole vault behind a
        // single strike and expiry.
        let limits: Limits = env.storage().instance().get(&DataKey::Limits).unwrap();
        if amount > limits.max_position(kind) {
            panic_with_error!(&env, Error::PositionTooLarge);
        }

        let this = env.current_contract_address();
        token::Client::new(&env, kind.collateral(&cfg)).transfer(&owner, &this, &amount);
        // Book the escrow BEFORE the premium leaves, so a put's own collateral
        // can never be counted as pool liquidity paying for its own premium.
        Self::add_escrow(&env, kind, amount);
        if premium > 0 {
            token::Client::new(&env, &cfg.cash).transfer(&this, &owner, &premium);
        }

        // Reserve the assignment payout this position may cost the vault, then
        // prove both pools still cover everything outstanding. Writing an
        // option the vault cannot settle would leave the writer holding a
        // promise it cannot keep, so a short pool rejects the whole deposit
        // rather than take the position on.
        let scale = 10i128.pow(ReflectorClient::new(&env, &cfg.oracle).decimals());
        Self::add_owed(
            &env,
            kind,
            Self::obligation(&env, kind, amount, strike, scale),
        );
        // Both sides are checked on every open: the premium always leaves the
        // cash pool, so even writing a put can push the call side short.
        Self::require_solvent(&env, &cfg, Kind::Call);
        Self::require_solvent(&env, &cfg, Kind::Put);

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap();
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        env.storage().persistent().set(
            &DataKey::Position(id),
            &Position {
                owner: owner.clone(),
                kind,
                amount,
                strike,
                expiry,
                premium,
                settled: false,
                outcome: symbol_short!("open"),
            },
        );

        env.events().publish(
            (symbol_short!("deposit"), id),
            (owner, amount, strike, expiry, premium, kind),
        );
        id
    }

    /// `pool` rides along as a second topic so the two pools can be told apart
    /// — and filtered for — at the RPC level, without resolving token addresses.
    fn store_limits(env: &Env, limits: &Limits) {
        if limits.max_position_call <= 0 || limits.max_position_put <= 0 {
            panic_with_error!(env, Error::InvalidLimit);
        }
        env.storage().instance().set(&DataKey::Limits, limits);
    }

    fn fund_pool(env: &Env, token_id: &Address, pool: Symbol, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }
        token::Client::new(env, token_id).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        env.events()
            .publish((symbol_short!("fund"), pool), (from, amount));
    }

    /// What the vault pays the writer if a position of this shape assigns, in
    /// the payout token's units. `settle` pays exactly this and `write`
    /// reserves exactly this, so the solvency guard can never drift from the
    /// payout it is guarding.
    ///
    ///   Call → cash  = amount[underlying] × strike[10^dec $/unit] / 10^dec
    ///   Put  → units = amount[cash] × 10^dec / strike[10^dec $/unit]
    ///
    /// Collateral and cash are both 7-decimal token units, so their scales
    /// cancel and only the oracle scaling remains.
    fn obligation(env: &Env, kind: Kind, amount: i128, strike: i128, scale: i128) -> i128 {
        let (num, den) = match kind {
            Kind::Call => (strike, scale),
            Kind::Put => (scale, strike),
        };
        amount
            .checked_mul(num)
            .unwrap_or_else(|| panic_with_error!(env, Error::InvalidAmount))
            / den
    }

    /// Every open position of `kind` must be settleable out of the pool its
    /// payouts draw on. That pool's token doubles as the OPPOSITE kind's
    /// collateral, which is held for its writers and must not be lent against
    /// — hence `balance - escrowed(opposite)` rather than the raw balance.
    fn require_solvent(env: &Env, cfg: &Config, kind: Kind) {
        let balance = token::Client::new(env, kind.payout(cfg)).balance(&env.current_contract_address());
        let free = balance - Self::escrow_of(env, kind.opposite());
        if free < Self::owed_of(env, kind) {
            panic_with_error!(env, Error::InsufficientPool);
        }
    }

    fn escrow_of(env: &Env, kind: Kind) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Escrowed(kind))
            .unwrap_or(0)
    }

    fn owed_of(env: &Env, kind: Kind) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Owed(kind))
            .unwrap_or(0)
    }

    /// Move the escrow counter for `kind` by `delta` (negative on release).
    fn add_escrow(env: &Env, kind: Kind, delta: i128) {
        let next = Self::bump(env, Self::escrow_of(env, kind), delta);
        env.storage().instance().set(&DataKey::Escrowed(kind), &next);
    }

    /// Move the outstanding-payout counter for `kind` by `delta`.
    fn add_owed(env: &Env, kind: Kind, delta: i128) {
        let next = Self::bump(env, Self::owed_of(env, kind), delta);
        env.storage().instance().set(&DataKey::Owed(kind), &next);
    }

    /// Overflow or a negative total means the books no longer match the
    /// contract's balances, so it panics rather than continue on bad state.
    fn bump(env: &Env, current: i128, delta: i128) -> i128 {
        let next = current
            .checked_add(delta)
            .unwrap_or_else(|| panic_with_error!(env, Error::InvalidAmount));
        if next < 0 {
            panic_with_error!(env, Error::InvalidAmount);
        }
        next
    }

    /// Expiry-pinned settlement price, mirroring the off-chain vault's rule:
    /// the writer's claim timing must not change the outcome. Reads the
    /// historical price at the expiry period; falls back to `lastprice` only
    /// while it is fresh (≤ 1h). A stale/empty feed BLOCKS settlement
    /// (fail-closed) rather than settling at a wrong price.
    fn settlement_price(
        env: &Env,
        oracle: &ReflectorClient,
        cfg: &Config,
        expiry: u64,
        now: u64,
    ) -> i128 {
        let asset = reflector::Asset::Other(cfg.feed.clone());

        // Normalize the expiry to the feed's resolution grid. Reflector
        // documents resolution in seconds (300 = 5min) but some deployments
        // report milliseconds (300000); treat implausibly-large values as ms.
        let res_raw = oracle.resolution();
        let res_secs: u64 = if res_raw >= 100_000 { (res_raw / 1000) as u64 } else { res_raw as u64 };
        let ts_norm = if res_secs > 0 { expiry - (expiry % res_secs) } else { expiry };

        if let Some(p) = oracle.price(&asset, &ts_norm) {
            return p.price;
        }
        // No historical record. The live price is a valid proxy for the
        // expiry price ONLY when the claim is prompt — within the staleness
        // window of EXPIRY, before the period record is queryable. For a late
        // claim (Reflector retains ~24h; the record has been pruned) the live
        // price is just the current market, and settling on it would re-grant
        // the writer the timing discretion expiry-pinning removes. So gate on
        // `now - expiry`, not merely on how fresh the lastprice record is.
        if now.saturating_sub(expiry) > MAX_PRICE_STALENESS_SECS {
            panic_with_error!(env, Error::StalePrice);
        }
        let lp = oracle
            .lastprice(&asset)
            .unwrap_or_else(|| panic_with_error!(env, Error::NoPrice));
        if now.saturating_sub(lp.timestamp) > MAX_PRICE_STALENESS_SECS {
            panic_with_error!(env, Error::StalePrice);
        }
        lp.price
    }
}

#[cfg(test)]
mod test;
