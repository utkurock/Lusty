#![cfg(test)]

use super::reflector::{Asset, PriceData};
use super::{LustyVault, LustyVaultClient};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, Symbol};

// ── Mock Reflector oracle ───────────────────────────────────────────
// Implements the same external interface; prices are set per normalized
// timestamp so tests control exactly what "the price at expiry" is.

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_price(env: Env, timestamp: u64, price: i128) {
        env.storage().persistent().set(&timestamp, &price);
    }

    pub fn set_lastprice(env: Env, price: i128, timestamp: u64) {
        env.storage()
            .instance()
            .set(&symbol_short!("last"), &PriceData { price, timestamp });
    }

    pub fn price(env: Env, _asset: Asset, timestamp: u64) -> Option<PriceData> {
        env.storage()
            .persistent()
            .get::<u64, i128>(&timestamp)
            .map(|price| PriceData { price, timestamp })
    }

    pub fn lastprice(env: Env, _asset: Asset) -> Option<PriceData> {
        env.storage().instance().get(&symbol_short!("last"))
    }

    pub fn decimals(_env: Env) -> u32 {
        14
    }

    pub fn resolution(_env: Env) -> u32 {
        300
    }
}

// ── Harness ─────────────────────────────────────────────────────────

struct Setup<'a> {
    env: Env,
    vault: LustyVaultClient<'a>,
    oracle: MockOracleClient<'a>,
    token: token::Client<'a>,
    writer: Address,
    treasury: Address,
}

// Aligned to the mock feed's 300s resolution so EXPIRY normalizes to itself.
const START: u64 = 1_750_000_200;
const EXPIRY: u64 = START + 7 * 86400;
// Strike at oracle scale (14 decimals): $0.25
const STRIKE: i128 = 25_000_000_000_000;
const COLLATERAL: i128 = 100_0000000; // 100 XLM in stroops

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = START);

    let admin = Address::generate(&env);
    let writer = Address::generate(&env);
    let treasury = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&env, &sac.address());
    token::StellarAssetClient::new(&env, &sac.address()).mint(&writer, &1_000_0000000);

    let oracle_id = env.register(MockOracle, ());
    let oracle = MockOracleClient::new(&env, &oracle_id);

    let vault_id = env.register(
        LustyVault,
        (
            oracle_id.clone(),
            Symbol::new(&env, "XLM"),
            sac.address(),
            treasury.clone(),
        ),
    );
    let vault = LustyVaultClient::new(&env, &vault_id);

    Setup { env, vault, oracle, token, writer, treasury }
}

// ── Tests ───────────────────────────────────────────────────────────

#[test]
fn deposit_escrows_collateral() {
    let s = setup();
    let before = s.token.balance(&s.writer);
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);
    assert_eq!(id, 0);
    assert_eq!(s.token.balance(&s.writer), before - COLLATERAL);
    assert_eq!(s.token.balance(&s.vault.address), COLLATERAL);

    let pos = s.vault.position(&id);
    assert_eq!(pos.owner, s.writer);
    assert_eq!(pos.amount, COLLATERAL);
    assert_eq!(pos.strike, STRIKE);
    assert_eq!(pos.expiry, EXPIRY);
    assert!(!pos.settled);
}

#[test]
fn ids_increment() {
    let s = setup();
    let a = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);
    let b = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);
    assert_eq!((a, b), (0, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // InvalidAmount
fn deposit_rejects_zero_amount() {
    let s = setup();
    s.vault.deposit(&s.writer, &0, &STRIKE, &EXPIRY);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // InvalidExpiry
fn deposit_rejects_past_expiry() {
    let s = setup();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &(START - 1));
}

#[test]
fn settle_otm_returns_collateral_to_writer() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);

    // Price at expiry $0.23 < $0.25 strike → kept.
    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);

    let outcome = s.vault.settle(&id);
    assert_eq!(outcome, symbol_short!("kept"));
    assert_eq!(s.token.balance(&s.writer), 1_000_0000000);
    assert_eq!(s.token.balance(&s.vault.address), 0);
    assert!(s.vault.position(&id).settled);
}

#[test]
fn settle_itm_routes_collateral_to_treasury() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);

    // Price at expiry $0.30 > $0.25 strike → assigned.
    s.oracle.set_price(&EXPIRY, &30_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);

    let outcome = s.vault.settle(&id);
    assert_eq!(outcome, symbol_short!("assigned"));
    assert_eq!(s.token.balance(&s.treasury), COLLATERAL);
    assert_eq!(s.token.balance(&s.vault.address), 0);
}

#[test]
fn settlement_is_pinned_to_expiry_not_claim_time() {
    // The off-chain vault's core rule, now on-chain: a writer waiting for a
    // dip after expiry must NOT be able to dodge assignment.
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);

    // ITM at expiry ($0.30), crashed later ($0.10). Settles at expiry price.
    s.oracle.set_price(&EXPIRY, &30_000_000_000_000);
    s.oracle.set_lastprice(&10_000_000_000_000, &(EXPIRY + 86400));
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 86400);

    assert_eq!(s.vault.settle(&id), symbol_short!("assigned"));
}

#[test]
fn settle_normalizes_expiry_to_feed_resolution() {
    let s = setup();
    // Expiry 100s into a 300s period → price recorded at the period start.
    let expiry = EXPIRY + 100;
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &expiry);
    s.oracle.set_price(&EXPIRY, &30_000_000_000_000); // EXPIRY % 300 == 0
    s.env.ledger().with_mut(|l| l.timestamp = expiry + 60);

    assert_eq!(s.vault.settle(&id), symbol_short!("assigned"));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // NotExpired
fn settle_rejects_before_expiry() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY - 1);
    s.vault.settle(&id);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // AlreadySettled
fn settle_rejects_double_settlement() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);
    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);
    s.vault.settle(&id);
}

#[test]
fn settle_falls_back_to_fresh_lastprice() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);
    // No historical record; lastprice is 10 min old → accepted.
    let now = EXPIRY + 60;
    s.oracle.set_lastprice(&23_000_000_000_000, &(now - 600));
    s.env.ledger().with_mut(|l| l.timestamp = now);

    assert_eq!(s.vault.settle(&id), symbol_short!("kept"));
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")] // StalePrice
fn settle_blocks_on_stale_fallback() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);
    // No historical record; lastprice is 2h old → fail closed.
    let now = EXPIRY + 60;
    s.oracle.set_lastprice(&23_000_000_000_000, &(now - 7200));
    s.env.ledger().with_mut(|l| l.timestamp = now);
    s.vault.settle(&id);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // NoPrice
fn settle_blocks_when_feed_is_empty() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);
}

#[test]
#[should_panic] // missing writer auth
fn deposit_requires_writer_auth() {
    let env = Env::default(); // NO mock_all_auths
    env.ledger().with_mut(|l| l.timestamp = START);
    let admin = Address::generate(&env);
    let writer = Address::generate(&env);
    let treasury = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let oracle_id = env.register(MockOracle, ());
    let vault_id = env.register(
        LustyVault,
        (oracle_id, Symbol::new(&env, "XLM"), sac.address(), treasury),
    );
    let vault = LustyVaultClient::new(&env, &vault_id);
    vault.deposit(&writer, &COLLATERAL, &STRIKE, &EXPIRY);
}
