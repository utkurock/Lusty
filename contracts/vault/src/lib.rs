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
//! Remaining for T3: cash-secured puts, position tokens, upgrade governance,
//! automated pool solvency management (today: ops funds the pool via `fund`).

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
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    /// Reflector oracle contract this vault settles against.
    pub oracle: Address,
    /// Feed symbol queried as `Asset::Other(feed)` — e.g. "XLM".
    pub feed: Symbol,
    /// Collateral token (SAC address; native XLM SAC for covered calls).
    pub token: Address,
    /// Cash token (USDC SAC) — premiums out, assignment payouts out.
    pub cash: Address,
    /// Receives assigned collateral (T3: automated solvency management).
    pub treasury: Address,
    /// Pricing-engine key that must co-sign every deposit's premium (RFQ).
    pub quoter: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct Position {
    pub owner: Address,
    /// Collateral escrowed, in the token's stroops/units.
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
    ) {
        env.storage().instance().set(
            &DataKey::Config,
            &Config { oracle, feed, token, cash, treasury, quoter },
        );
        env.storage().instance().set(&DataKey::NextId, &0u64);
    }

    /// Top up the cash pool that pays premiums and assignment payouts.
    /// Permissionless — anyone may add solvency, nobody can take it out
    /// except through settlement.
    pub fn fund(env: Env, from: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        token::Client::new(&env, &cfg.cash).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        env.events().publish((symbol_short!("fund"),), (from, amount));
    }

    /// Write a covered call: escrow `amount` collateral at `strike` until
    /// `expiry`, receiving `premium` cash instantly from the pool — one
    /// atomic transaction. The writer authorizes the collateral transfer;
    /// the quoter (pricing engine) co-signs the premium figure, so neither
    /// side can set the price alone. If the pool cannot cover the premium
    /// the deposit fails whole (fail-closed).
    pub fn deposit(
        env: Env,
        owner: Address,
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

        let this = env.current_contract_address();
        token::Client::new(&env, &cfg.token).transfer(&owner, &this, &amount);
        if premium > 0 {
            token::Client::new(&env, &cfg.cash).transfer(&this, &owner, &premium);
        }

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap();
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        env.storage().persistent().set(
            &DataKey::Position(id),
            &Position {
                owner: owner.clone(),
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
            (owner, amount, strike, expiry, premium),
        );
        id
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
        let outcome = if price > pos.strike {
            // Assigned: writer sells the collateral at the strike. Collateral
            // to treasury; strike value to the writer in cash.
            //   cash = amount[token units] × strike[10^dec $/unit] / 10^dec
            // (token stroops and cash units are both 7 decimals, so the
            // scales cancel and only the oracle scaling remains.)
            let dec = oracle.decimals();
            let strike_value = pos
                .amount
                .checked_mul(pos.strike)
                .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidAmount))
                / 10i128.pow(dec);
            token::Client::new(&env, &cfg.token).transfer(&this, &cfg.treasury, &pos.amount);
            if strike_value > 0 {
                token::Client::new(&env, &cfg.cash).transfer(&this, &pos.owner, &strike_value);
            }
            symbol_short!("assigned")
        } else {
            token::Client::new(&env, &cfg.token).transfer(&this, &pos.owner, &pos.amount);
            symbol_short!("kept")
        };

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
