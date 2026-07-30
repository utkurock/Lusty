//! Lusty Vault — trustless options vault (Soroban, v4).
//!
//! The full money loop is on-chain. All three legs of a written option are
//! contract-enforced:
//!
//!   1. ESCROW: collateral (XLM) is held by this contract — nobody, including
//!      the protocol, can move it except through `settle()`.
//!   2. PREMIUM: paid to the writer in cash (USDC) from the contract's pool
//!      ATOMICALLY inside `deposit()` — no separate server payout to trust.
//!      The premium amount is the protocol's signed offer: `open` requires
//!      auth from both the writer AND an authorised quoter (a pricing-engine
//!      key), the on-chain equivalent of an RFQ. Custody and settlement never
//!      depend on a quoter, `Limits::max_premium_bps` bounds what one
//!      signature can be worth — a premium is capped at a share of the
//!      collateral escrowed against it, valued at the oracle price — and the
//!      admin can revoke a key without touching anything it already priced.
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
    Address, Env, Symbol, Vec,
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
    ExpiryFull = 13,
    PremiumTooHigh = 14,
    /// The address offered as the quote's signer is not an authorised quoter.
    UnknownQuoter = 15,
    QuoterExists = 16,
    /// Removing the last quoter would leave no key able to price a position,
    /// closing the vault to new writers. Rotate by adding first, then removing.
    LastQuoter = 17,
    TooManyQuoters = 18,
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
    /// Sets the risk limits and maintains the quoter set. Custody and
    /// settlement never route through it: the admin cannot move collateral,
    /// price an option or settle a position.
    pub admin: Address,
}

/// Most pricing keys the vault will hold at once. The set exists for rotation
/// and redundancy, not for scale — every member can price up to
/// `Limits::max_premium_bps`, so a larger set is a wider trust surface, and
/// the bound keeps it from growing there by accident.
pub const MAX_QUOTERS: u32 = 8;

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
    /// Most collateral the vault will hold against ONE expiry, per kind. Caps
    /// how much of the book can come due — and be settled at one price — on a
    /// single date, which position size alone does not bound.
    pub max_expiry_call: i128,
    pub max_expiry_put: i128,
    /// Largest premium a position may pay, in basis points of the collateral
    /// the writer escrowed. The one limit that binds the QUOTER rather than the
    /// writer: without it a compromised pricing key could quote itself the
    /// whole cash pool, since nothing else about `write` looks at the premium.
    /// Above 10_000 (100% of collateral) the vault would pay out more than it
    /// took in, so that is the hard ceiling on the ceiling.
    pub max_premium_bps: u32,
}

/// Denominator for `max_premium_bps`.
const BPS: i128 = 10_000;

impl Limits {
    fn max_position(&self, kind: Kind) -> i128 {
        match kind {
            Kind::Call => self.max_position_call,
            Kind::Put => self.max_position_put,
        }
    }

    fn max_expiry(&self, kind: Kind) -> i128 {
        match kind {
            Kind::Call => self.max_expiry_call,
            Kind::Put => self.max_expiry_put,
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
    /// Pricing keys allowed to co-sign a premium. Held apart from `Config`
    /// because, like `Limits`, this is a value the admin can change — and
    /// unlike `Config`, it is the one the vault's day-to-day safety rests on.
    Quoters,
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
    /// Collateral escrowed against one expiry, per kind. Persistent rather
    /// than instance storage: expiries accumulate without bound, and a settled
    /// date's bucket must not weigh on every later deposit.
    Exposure(Kind, u64),
    /// How many positions an owner has ever written.
    OwnerCount(Address),
    /// The owner's `n`-th position id. One small entry per slot instead of a
    /// growing vector, so an active writer can never outgrow a single ledger
    /// entry's size limit.
    OwnerAt(Address, u32),
}

/// Vault-wide totals, in one read, for verifying solvency from outside. The
/// contract's own guard is exactly `balance - escrowed(other) >= owed(kind)`.
#[contracttype]
#[derive(Clone)]
pub struct Stats {
    /// Underlying escrowed by call writers.
    pub escrowed_call: i128,
    /// Cash escrowed by put writers.
    pub escrowed_put: i128,
    /// Cash the vault owes if every open call assigns.
    pub owed_call: i128,
    /// Underlying the vault owes if every open put assigns.
    pub owed_put: i128,
    /// Raw token balances held by the contract.
    pub cash_balance: i128,
    pub underlying_balance: i128,
    /// Ids issued so far — position ids run `0..next_id`.
    pub next_id: u64,
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
        quoters: Vec<Address>,
        admin: Address,
        limits: Limits,
    ) {
        env.storage().instance().set(
            &DataKey::Config,
            &Config { oracle, feed, token, cash, treasury, admin },
        );
        Self::store_quoters(&env, &quoters);
        Self::store_limits(&env, &limits);
        env.storage().instance().set(&DataKey::NextId, &0u64);
    }

    /// Authorise another pricing key. Admin-only, and the reason the admin
    /// account is worth putting behind a multisig: this is the one call that
    /// can widen who may set a premium.
    ///
    /// Rotation is add-then-remove, so the vault never passes through a state
    /// with no quoter and no new writers can be opened in the gap.
    pub fn add_quoter(env: Env, quoter: Address) {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        cfg.admin.require_auth();
        let mut quoters = Self::quoter_set(&env);
        if quoters.contains(&quoter) {
            panic_with_error!(&env, Error::QuoterExists);
        }
        quoters.push_back(quoter.clone());
        Self::store_quoters(&env, &quoters);
        env.events()
            .publish((symbol_short!("quoter"), symbol_short!("add")), quoter);
    }

    /// Revoke a pricing key — the response to a compromised quoter, and the
    /// half of rotation that matters. Positions it already priced are
    /// untouched: their premium is paid and their collateral is escrowed, and
    /// settlement never consults a quoter.
    pub fn remove_quoter(env: Env, quoter: Address) {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        cfg.admin.require_auth();
        let quoters = Self::quoter_set(&env);
        let index = quoters
            .first_index_of(&quoter)
            .unwrap_or_else(|| panic_with_error!(&env, Error::UnknownQuoter));
        if quoters.len() == 1 {
            panic_with_error!(&env, Error::LastQuoter);
        }
        let mut remaining = quoters;
        remaining.remove(index);
        Self::store_quoters(&env, &remaining);
        env.events()
            .publish((symbol_short!("quoter"), symbol_short!("remove")), quoter);
    }

    /// Every key currently allowed to price a position. Public so the set the
    /// vault actually enforces can be read from state and compared against
    /// whatever the operator says it is.
    pub fn quoters(env: Env) -> Vec<Address> {
        Self::quoter_set(&env)
    }

    pub fn is_quoter(env: Env, quoter: Address) -> bool {
        Self::quoter_set(&env).contains(&quoter)
    }

    /// Adjust the risk limits. Admin-only: it can shrink what the vault
    /// accepts, never reach the collateral already escrowed under the old
    /// limits. Together with the quoter set, this is the whole of what the
    /// admin can do — it prices nothing, holds nothing and settles nothing.
    ///
    /// `max_premium_bps` is the one limit that also widens something — the band
    /// the quoter prices in. The admin still cannot pay a premium (only the
    /// quoter signs one) and the quoter cannot raise its own band, so the two
    /// keys bound each other. They must not be the same account.
    pub fn set_limits(env: Env, limits: Limits) {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        cfg.admin.require_auth();
        Self::store_limits(&env, &limits);
        env.events().publish(
            (symbol_short!("limits"),),
            (
                limits.max_position_call,
                limits.max_position_put,
                limits.max_premium_bps,
            ),
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

    /// Write a covered call — a thin wrapper over [`Self::open`] for the leg
    /// that has one by default.
    pub fn deposit(
        env: Env,
        owner: Address,
        amount: i128,
        strike: i128,
        expiry: u64,
        premium: i128,
        quoter: Address,
    ) -> u64 {
        Self::write(env, owner, Kind::Call, amount, strike, expiry, premium, quoter)
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
    ///
    /// `quoter` names which authorised pricing key is co-signing this premium.
    /// It is an argument rather than something the contract looks up because
    /// authorization has to be demanded of one specific address: with a set,
    /// requiring every member to sign would need all of them online, and the
    /// contract cannot ask "did any of you sign?" after the fact. Naming the
    /// signer keeps the check exact — the address must be in the set AND must
    /// have authorized this exact call.
    pub fn open(
        env: Env,
        owner: Address,
        kind: Kind,
        amount: i128,
        strike: i128,
        expiry: u64,
        premium: i128,
        quoter: Address,
    ) -> u64 {
        Self::write(env, owner, kind, amount, strike, expiry, premium, quoter)
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

    /// Collateral currently escrowed against `expiry` for `kind` — the figure
    /// checked against `Limits::max_expiry`. Lets a client see how much room
    /// an expiry has left before it quotes against it.
    pub fn exposure(env: Env, kind: Kind, expiry: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Exposure(kind, expiry))
            .unwrap_or(0)
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
        Self::add_exposure(&env, pos.kind, pos.expiry, -pos.amount);

        pos.settled = true;
        pos.outcome = outcome.clone();
        env.storage().persistent().set(&key, &pos);

        env.events()
            .publish((symbol_short!("settle"), id), (outcome.clone(), price));
        outcome
    }

    /// How many positions `owner` has written, settled ones included.
    pub fn position_count(env: Env, owner: Address) -> u32 {
        Self::owner_count(&env, &owner)
    }

    /// Page through an owner's position ids, oldest first. Paged because a
    /// long-lived writer's history outgrows a single read budget; `limit` is
    /// clamped to 100.
    pub fn positions_of(env: Env, owner: Address, start: u32, limit: u32) -> Vec<u64> {
        let count = Self::owner_count(&env, &owner);
        let end = start.saturating_add(limit.min(100)).min(count);
        let mut ids = Vec::new(&env);
        let mut i = start;
        while i < end {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<DataKey, u64>(&DataKey::OwnerAt(owner.clone(), i))
            {
                ids.push_back(id);
            }
            i += 1;
        }
        ids
    }

    /// Vault-wide totals for an outside solvency check, in a single call.
    pub fn stats(env: Env) -> Stats {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        let this = env.current_contract_address();
        Stats {
            escrowed_call: Self::escrow_of(&env, Kind::Call),
            escrowed_put: Self::escrow_of(&env, Kind::Put),
            owed_call: Self::owed_of(&env, Kind::Call),
            owed_put: Self::owed_of(&env, Kind::Put),
            cash_balance: token::Client::new(&env, &cfg.cash).balance(&this),
            underlying_balance: token::Client::new(&env, &cfg.token).balance(&this),
            next_id: env.storage().instance().get(&DataKey::NextId).unwrap(),
        }
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
        quoter: Address,
    ) -> u64 {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        owner.require_auth();
        // Membership before authorization, so an unauthorised address is
        // rejected for what it is rather than for a signature nobody would
        // have accepted anyway.
        if !Self::quoter_set(&env).contains(&quoter) {
            panic_with_error!(&env, Error::UnknownQuoter);
        }
        quoter.require_auth();
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
        // Premium ceiling: the one limit aimed at the QUOTER rather than the
        // writer. Every other check bounds what the writer may bring; nothing
        // else bounds what the protocol may pay them, so a compromised pricing
        // key could otherwise quote a single writer the whole cash pool.
        let oracle = ReflectorClient::new(&env, &cfg.oracle);
        let scale = 10i128.pow(oracle.decimals());
        if premium > Self::premium_cap(&env, &oracle, &cfg, &limits, kind, amount, scale) {
            panic_with_error!(&env, Error::PremiumTooHigh);
        }
        // Exposure cap: nor should many writers together, which the size cap
        // alone allows. Counted per expiry, so the book stays spread across
        // settlement dates instead of concentrating on one price print.
        let exposure = Self::add_exposure(&env, kind, expiry, amount);
        if exposure > limits.max_expiry(kind) {
            panic_with_error!(&env, Error::ExpiryFull);
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
        Self::index_for_owner(&env, &owner, id);
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

    fn quoter_set(env: &Env) -> Vec<Address> {
        env.storage().instance().get(&DataKey::Quoters).unwrap()
    }

    /// Reject a set that would brick the vault or quietly widen it: empty
    /// leaves nobody able to price, duplicates make `remove_quoter` look like
    /// it revoked a key it did not, and an unbounded set outgrows what one
    /// instance entry can hold.
    fn store_quoters(env: &Env, quoters: &Vec<Address>) {
        if quoters.is_empty() {
            panic_with_error!(env, Error::LastQuoter);
        }
        if quoters.len() > MAX_QUOTERS {
            panic_with_error!(env, Error::TooManyQuoters);
        }
        for (i, quoter) in quoters.iter().enumerate() {
            if quoters.first_index_of(&quoter).unwrap() != i as u32 {
                panic_with_error!(env, Error::QuoterExists);
            }
        }
        env.storage().instance().set(&DataKey::Quoters, quoters);
    }

    /// `pool` rides along as a second topic so the two pools can be told apart
    /// — and filtered for — at the RPC level, without resolving token addresses.
    fn store_limits(env: &Env, limits: &Limits) {
        if limits.max_position_call <= 0
            || limits.max_position_put <= 0
            || limits.max_expiry_call < limits.max_position_call
            || limits.max_expiry_put < limits.max_position_put
            // A premium worth more than the collateral it is paid against is a
            // loss taken at the moment of writing, so 100% bounds the bound.
            || limits.max_premium_bps == 0
            || limits.max_premium_bps as i128 > BPS
        {
            // An expiry cap below the position cap would make the larger of the
            // two unreachable — a limit set that can never be met as written.
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
        Self::mul(env, amount, num) / den
    }

    /// The most cash this position may be paid for being written: a share of
    /// the collateral the writer actually escrowed, in cash terms.
    ///
    /// The collateral is valued at the ORACLE price, never at the strike. The
    /// strike is the quoter's own number, so a strike-denominated ceiling
    /// would rise with it — a dust position at an absurd strike could buy an
    /// arbitrarily large premium, and a ceiling the quoter can move is not a
    /// ceiling. Priced at spot, raising the ceiling costs real escrowed
    /// collateral, which `Limits::max_position` already bounds.
    fn premium_cap(
        env: &Env,
        oracle: &ReflectorClient,
        cfg: &Config,
        limits: &Limits,
        kind: Kind,
        amount: i128,
        scale: i128,
    ) -> i128 {
        let value = match kind {
            // A put's collateral IS cash — the same token the premium is paid
            // in — so it needs no price, and the put leg keeps trading through
            // a feed outage.
            Kind::Put => amount,
            Kind::Call => Self::mul(env, amount, Self::spot(env, oracle, cfg)) / scale,
        };
        Self::mul(env, value, limits.max_premium_bps as i128) / BPS
    }

    /// Live oracle price, for valuing collateral as it is escrowed. Settlement
    /// wants the price AT expiry; this wants the price NOW, so `lastprice` is
    /// the right read — but a stale one must block the write rather than value
    /// today's collateral at a price that no longer holds.
    fn spot(env: &Env, oracle: &ReflectorClient, cfg: &Config) -> i128 {
        let lp = oracle
            .lastprice(&reflector::Asset::Other(cfg.feed.clone()))
            .unwrap_or_else(|| panic_with_error!(env, Error::NoPrice));
        if env
            .ledger()
            .timestamp()
            .saturating_sub(lp.timestamp)
            > MAX_PRICE_STALENESS_SECS
        {
            panic_with_error!(env, Error::StalePrice);
        }
        lp.price
    }

    fn mul(env: &Env, a: i128, b: i128) -> i128 {
        a.checked_mul(b)
            .unwrap_or_else(|| panic_with_error!(env, Error::InvalidAmount))
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

    fn owner_count(env: &Env, owner: &Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::OwnerCount(owner.clone()))
            .unwrap_or(0)
    }

    /// Append `id` to the owner's index so their positions stay discoverable
    /// from contract state alone, long after the RPC's event window has rolled
    /// past the deposit.
    fn index_for_owner(env: &Env, owner: &Address, id: u64) {
        let n = Self::owner_count(env, owner);
        env.storage()
            .persistent()
            .set(&DataKey::OwnerAt(owner.clone(), n), &id);
        env.storage()
            .persistent()
            .set(&DataKey::OwnerCount(owner.clone()), &(n + 1));
    }

    /// Move this expiry's exposure by `delta` and return the new total.
    fn add_exposure(env: &Env, kind: Kind, expiry: u64, delta: i128) -> i128 {
        let key = DataKey::Exposure(kind, expiry);
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let next = Self::bump(env, current, delta);
        env.storage().persistent().set(&key, &next);
        next
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
