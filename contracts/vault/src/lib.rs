//! Lusty Vault — trustless covered-call escrow (Soroban PoC).
//!
//! This is the Tranche-1 proof of concept for moving Lusty's settlement
//! on-chain. It replaces the two trust assumptions of the current server-side
//! vault with contract guarantees:
//!
//!   1. ESCROW: collateral is held by this contract, not by a custodial
//!      distributor account. Nobody — including the protocol — can move it
//!      except through `settle()`.
//!   2. ORACLE SETTLEMENT: the assignment decision (spot vs strike at expiry)
//!      is read from a Reflector price feed on-chain, pinned to the expiry
//!      timestamp — the same expiry-pinned rule the off-chain vault enforces,
//!      now without trusting our server.
//!
//! Deliberately out of scope for the PoC (tracked for T2): premium payout in
//! LUSD at deposit time, cash-secured puts, partial fills, position NFTs.
//! Assignment routes collateral to the protocol treasury; in T2 it will be
//! swapped at the strike and the USD leg returned to the writer.

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
    /// Where assigned collateral is routed (T2: swap at strike instead).
    pub treasury: Address,
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
    pub fn __constructor(env: Env, oracle: Address, feed: Symbol, token: Address, treasury: Address) {
        env.storage().instance().set(&DataKey::Config, &Config { oracle, feed, token, treasury });
        env.storage().instance().set(&DataKey::NextId, &0u64);
    }

    /// Escrow `amount` of collateral as a covered call at `strike` until
    /// `expiry`. The writer authorizes the token transfer; the collateral can
    /// only leave through `settle()`.
    pub fn deposit(env: Env, owner: Address, amount: i128, strike: i128, expiry: u64) -> u64 {
        owner.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if strike <= 0 {
            panic_with_error!(&env, Error::InvalidStrike);
        }
        if expiry <= env.ledger().timestamp() {
            panic_with_error!(&env, Error::InvalidExpiry);
        }

        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        token::Client::new(&env, &cfg.token).transfer(
            &owner,
            &env.current_contract_address(),
            &amount,
        );

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap();
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        env.storage().persistent().set(
            &DataKey::Position(id),
            &Position {
                owner: owner.clone(),
                amount,
                strike,
                expiry,
                settled: false,
                outcome: symbol_short!("open"),
            },
        );

        env.events()
            .publish((symbol_short!("deposit"), id), (owner, amount, strike, expiry));
        id
    }

    /// Settle an expired position against the oracle price AT EXPIRY.
    /// Permissionless: anyone may trigger it (the outcome is deterministic),
    /// so the writer does not depend on the protocol being online.
    ///
    ///   price(expiry) >  strike → assigned: collateral to the treasury
    ///   price(expiry) <= strike → kept:     collateral back to the writer
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
        let price = Self::settlement_price(&env, &cfg, pos.expiry, now);

        let outcome = if price > pos.strike {
            symbol_short!("assigned")
        } else {
            symbol_short!("kept")
        };
        let recipient = if price > pos.strike { &cfg.treasury } else { &pos.owner };
        token::Client::new(&env, &cfg.token).transfer(
            &env.current_contract_address(),
            recipient,
            &pos.amount,
        );

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
    fn settlement_price(env: &Env, cfg: &Config, expiry: u64, now: u64) -> i128 {
        let oracle = ReflectorClient::new(env, &cfg.oracle);
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
        // History not yet recorded (settling within the expiry period) or
        // already pruned — fall back to the live price while it is fresh.
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
