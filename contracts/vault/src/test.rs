#![cfg(test)]

use super::reflector::{Asset, PriceData};
use super::{LustyVault, LustyVaultClient};
use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::{
    contract, contractimpl, symbol_short, token, Address, Env, IntoVal, Symbol,
};

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
    cash: token::Client<'a>,
    writer: Address,
    treasury: Address,
    quoter: Address,
}

// Aligned to the mock feed's 300s resolution so EXPIRY normalizes to itself.
const START: u64 = 1_750_000_200;
const EXPIRY: u64 = START + 7 * 86400;
// Strike at oracle scale (14 decimals): $0.25
const STRIKE: i128 = 25_000_000_000_000;
const COLLATERAL: i128 = 100_0000000; // 100 XLM in stroops
const PREMIUM: i128 = 5_0000000; // $5 in cash units (7 decimals)
const POOL: i128 = 1_000_0000000; // $1000 pool
const WRITER_XLM: i128 = 1_000_0000000;

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = START);

    let admin = Address::generate(&env);
    let writer = Address::generate(&env);
    let treasury = Address::generate(&env);
    let quoter = Address::generate(&env);
    let funder = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&env, &sac.address());
    token::StellarAssetClient::new(&env, &sac.address()).mint(&writer, &WRITER_XLM);

    let usdc = env.register_stellar_asset_contract_v2(admin.clone());
    let cash = token::Client::new(&env, &usdc.address());
    token::StellarAssetClient::new(&env, &usdc.address()).mint(&funder, &POOL);

    let oracle_id = env.register(MockOracle, ());
    let oracle = MockOracleClient::new(&env, &oracle_id);

    let vault_id = env.register(
        LustyVault,
        (
            oracle_id.clone(),
            Symbol::new(&env, "XLM"),
            sac.address(),
            usdc.address(),
            treasury.clone(),
            quoter.clone(),
        ),
    );
    let vault = LustyVaultClient::new(&env, &vault_id);
    vault.fund(&funder, &POOL);

    Setup { env, vault, oracle, token, cash, writer, treasury, quoter }
}

// ── Deposit / premium ───────────────────────────────────────────────

#[test]
fn deposit_escrows_collateral_and_pays_premium_atomically() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    assert_eq!(id, 0);
    // Collateral escrowed by the contract…
    assert_eq!(s.token.balance(&s.writer), WRITER_XLM - COLLATERAL);
    assert_eq!(s.token.balance(&s.vault.address), COLLATERAL);
    // …and the premium hit the writer's cash balance in the same call.
    assert_eq!(s.cash.balance(&s.writer), PREMIUM);
    assert_eq!(s.cash.balance(&s.vault.address), POOL - PREMIUM);

    let pos = s.vault.position(&id);
    assert_eq!(pos.owner, s.writer);
    assert_eq!(pos.amount, COLLATERAL);
    assert_eq!(pos.strike, STRIKE);
    assert_eq!(pos.expiry, EXPIRY);
    assert_eq!(pos.premium, PREMIUM);
    assert!(!pos.settled);
}

#[test]
fn ids_increment() {
    let s = setup();
    let a = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    let b = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    assert_eq!((a, b), (0, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // InvalidAmount
fn deposit_rejects_zero_amount() {
    let s = setup();
    s.vault.deposit(&s.writer, &0, &STRIKE, &EXPIRY, &PREMIUM);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // InvalidExpiry
fn deposit_rejects_past_expiry() {
    let s = setup();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &(START - 1), &PREMIUM);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")] // InvalidPremium
fn deposit_rejects_negative_premium() {
    let s = setup();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &-1);
}

#[test]
#[should_panic] // pool can't cover the premium → whole deposit fails
fn deposit_fails_closed_when_pool_short() {
    let s = setup();
    s.vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &(POOL + 1));
}

// ── Settlement ──────────────────────────────────────────────────────

#[test]
fn settle_otm_returns_collateral_no_cash() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);

    // Price at expiry $0.23 < $0.25 strike → kept.
    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);

    let outcome = s.vault.settle(&id);
    assert_eq!(outcome, symbol_short!("kept"));
    assert_eq!(s.token.balance(&s.writer), WRITER_XLM);
    assert_eq!(s.token.balance(&s.vault.address), 0);
    // Writer keeps only the premium in cash; no settlement payout.
    assert_eq!(s.cash.balance(&s.writer), PREMIUM);
    assert!(s.vault.position(&id).settled);
}

#[test]
fn settle_itm_pays_strike_value_and_routes_collateral() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);

    // Price at expiry $0.30 > $0.25 strike → assigned.
    s.oracle.set_price(&EXPIRY, &30_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);

    let outcome = s.vault.settle(&id);
    assert_eq!(outcome, symbol_short!("assigned"));
    // Collateral to treasury.
    assert_eq!(s.token.balance(&s.treasury), COLLATERAL);
    assert_eq!(s.token.balance(&s.vault.address), 0);
    // Writer sold 100 XLM at the $0.25 strike → $25 cash, plus the premium.
    let strike_value = COLLATERAL * STRIKE / 10i128.pow(14); // 25_0000000
    assert_eq!(strike_value, 25_0000000);
    assert_eq!(s.cash.balance(&s.writer), PREMIUM + strike_value);
    assert_eq!(s.cash.balance(&s.vault.address), POOL - PREMIUM - strike_value);
}

#[test]
fn settlement_is_pinned_to_expiry_not_claim_time() {
    // The off-chain vault's core rule, now on-chain: a writer waiting for a
    // dip after expiry must NOT be able to dodge assignment.
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);

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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &expiry, &PREMIUM);
    s.oracle.set_price(&EXPIRY, &30_000_000_000_000); // EXPIRY % 300 == 0
    s.env.ledger().with_mut(|l| l.timestamp = expiry + 60);

    assert_eq!(s.vault.settle(&id), symbol_short!("assigned"));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // NotExpired
fn settle_rejects_before_expiry() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY - 1);
    s.vault.settle(&id);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // AlreadySettled
fn settle_rejects_double_settlement() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);
    s.vault.settle(&id);
}

#[test]
fn settle_falls_back_to_fresh_lastprice() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")] // StalePrice
fn settle_blocks_late_claim_with_pruned_history() {
    // The timing-discretion guard: an ITM writer must not be able to wait out
    // Reflector's ~24h retention and then settle on the (now unrelated) live
    // price. Here the expiry record is gone, the live price is perfectly fresh
    // and below strike (would settle "kept" and dodge assignment) — but the
    // claim is 2h after expiry, so the contract refuses rather than mis-settle.
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    let now = EXPIRY + 7200; // 2h late, > 1h staleness window
    s.oracle.set_lastprice(&23_000_000_000_000, &(now - 60)); // fresh, < strike
    s.env.ledger().with_mut(|l| l.timestamp = now);
    s.vault.settle(&id);
}

// ── Auth ────────────────────────────────────────────────────────────

#[test]
#[should_panic] // no auth mocked at all → writer auth missing
fn deposit_requires_writer_auth() {
    let env = Env::default(); // NO mock_all_auths
    env.ledger().with_mut(|l| l.timestamp = START);
    let admin = Address::generate(&env);
    let writer = Address::generate(&env);
    let treasury = Address::generate(&env);
    let quoter = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let usdc = env.register_stellar_asset_contract_v2(admin);
    let oracle_id = env.register(MockOracle, ());
    let vault_id = env.register(
        LustyVault,
        (
            oracle_id,
            Symbol::new(&env, "XLM"),
            sac.address(),
            usdc.address(),
            treasury,
            quoter,
        ),
    );
    let vault = LustyVaultClient::new(&env, &vault_id);
    vault.deposit(&writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
}

#[test]
#[should_panic] // writer signed, quoter did NOT → premium not protocol-approved
fn deposit_requires_quoter_cosignature() {
    let s = setup();
    // Re-arm auth mocking to cover ONLY the writer for this call.
    s.env.mock_auths(&[MockAuth {
        address: &s.writer,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "deposit",
            args: (
                s.writer.clone(),
                COLLATERAL,
                STRIKE,
                EXPIRY,
                PREMIUM,
            )
                .into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
}
