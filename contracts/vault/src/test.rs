#![cfg(test)]

use super::reflector::{Asset, PriceData};
use super::{Kind, LustyVault, LustyVaultClient};
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
// Cash securing 100 XLM at the $0.25 strike — the put-side mirror of COLLATERAL.
const PUT_COLLATERAL: i128 = 25_0000000;
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
    assert_eq!(pos.kind, Kind::Call);
    assert_eq!(pos.amount, COLLATERAL);
    assert_eq!(pos.strike, STRIKE);
    assert_eq!(pos.expiry, EXPIRY);
    assert_eq!(pos.premium, PREMIUM);
    assert!(!pos.settled);
}

#[test]
fn open_put_escrows_cash_collateral() {
    let s = setup();
    let id = open_put(&s);

    let pos = s.vault.position(&id);
    assert_eq!(pos.kind, Kind::Put);
    assert_eq!(pos.amount, PUT_COLLATERAL);
    // Cash went in, premium came back out — the writer nets the premium.
    assert_eq!(s.cash.balance(&s.writer), PREMIUM);
    assert_eq!(s.cash.balance(&s.vault.address), POOL + PUT_COLLATERAL - PREMIUM);
    // A put never touches the underlying at open.
    assert_eq!(s.token.balance(&s.writer), WRITER_XLM);
    // …and the escrow counter keeps it out of the free premium pool.
    assert_eq!(s.vault.escrowed(&Kind::Put), PUT_COLLATERAL);
    assert_eq!(s.vault.escrowed(&Kind::Call), 0);
    // Assignment would deliver 100 XLM, reserved against the underlying pool.
    assert_eq!(s.vault.owed(&Kind::Put), COLLATERAL);
    assert_eq!(s.vault.owed(&Kind::Call), 0);
}

// ── Pool solvency ───────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #10)")] // InsufficientPool
fn open_put_rejected_without_deliverable_inventory() {
    // The vault holds no underlying, so it could not honour the delivery this
    // put commits it to. Fail at open rather than strand the writer at expiry.
    let s = setup();
    token::StellarAssetClient::new(&s.env, &s.cash.address).mint(&s.writer, &PUT_COLLATERAL);
    s.vault
        .open(&s.writer, &Kind::Put, &PUT_COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")] // InsufficientPool
fn open_call_rejected_when_pool_cannot_cover_assignment() {
    // One call for 100 XLM at $0.25 owes $25 on assignment; the pool covers
    // forty of those. The forty-first is refused.
    let s = setup();
    token::StellarAssetClient::new(&s.env, &s.token.address).mint(&s.writer, &(COLLATERAL * 41));
    for _ in 0..41 {
        s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &0);
    }
}

#[test]
fn a_calls_escrow_is_not_lent_to_a_put() {
    // The call writer's 100 XLM sits in the same token the put would be paid
    // in. It backs their position only — a put must bring its own inventory.
    let s = setup();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    assert_eq!(s.token.balance(&s.vault.address), COLLATERAL);

    token::StellarAssetClient::new(&s.env, &s.cash.address).mint(&s.writer, &PUT_COLLATERAL);
    let refused = s.vault.try_open(
        &s.writer,
        &Kind::Put,
        &PUT_COLLATERAL,
        &STRIKE,
        &EXPIRY,
        &PREMIUM,
    );
    assert!(refused.is_err());
}

#[test]
fn open_matches_deposit_for_calls() {
    let s = setup();
    let a = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    let b = s
        .vault
        .open(&s.writer, &Kind::Call, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    assert_eq!(s.vault.position(&a).kind, s.vault.position(&b).kind);
    assert_eq!(s.vault.escrowed(&Kind::Call), COLLATERAL * 2);
}

#[test]
fn settlement_releases_the_escrow() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM);
    assert_eq!(s.vault.escrowed(&Kind::Call), COLLATERAL);

    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);

    assert_eq!(s.vault.escrowed(&Kind::Call), 0);
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

// ── Put settlement ──────────────────────────────────────────────────

/// Open a put and stock the vault with the underlying it may have to deliver.
fn open_put(s: &Setup<'_>) -> u64 {
    token::StellarAssetClient::new(&s.env, &s.cash.address).mint(&s.writer, &PUT_COLLATERAL);
    let stock = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token.address).mint(&stock, &COLLATERAL);
    s.vault.fund_underlying(&stock, &COLLATERAL);
    s.vault
        .open(&s.writer, &Kind::Put, &PUT_COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM)
}

#[test]
fn settle_put_above_strike_returns_the_cash() {
    let s = setup();
    let id = open_put(&s);

    // Price at expiry $0.30 > $0.25 strike → the put expires worthless.
    s.oracle.set_price(&EXPIRY, &30_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);

    assert_eq!(s.vault.settle(&id), symbol_short!("kept"));
    // Cash collateral back, premium kept, no underlying delivered.
    assert_eq!(s.cash.balance(&s.writer), PUT_COLLATERAL + PREMIUM);
    assert_eq!(s.token.balance(&s.writer), WRITER_XLM);
    assert_eq!(s.vault.escrowed(&Kind::Put), 0);
}

#[test]
fn settle_put_below_strike_delivers_the_underlying() {
    let s = setup();
    let id = open_put(&s);

    // Price at expiry $0.20 < $0.25 strike → assigned; the writer buys at $0.25.
    s.oracle.set_price(&EXPIRY, &20_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);

    assert_eq!(s.vault.settle(&id), symbol_short!("assigned"));
    // $25 of cash bought 100 XLM at the strike.
    let units = PUT_COLLATERAL * 10i128.pow(14) / STRIKE;
    assert_eq!(units, COLLATERAL);
    assert_eq!(s.token.balance(&s.writer), WRITER_XLM + units);
    // The cash they committed went to the treasury; they keep only the premium.
    assert_eq!(s.cash.balance(&s.treasury), PUT_COLLATERAL);
    assert_eq!(s.cash.balance(&s.writer), PREMIUM);
    assert_eq!(s.vault.escrowed(&Kind::Put), 0);
}

#[test]
fn put_settlement_is_pinned_to_expiry_not_claim_time() {
    // Mirror of the call-side guard: an assigned put writer must not be able to
    // wait for a rally and claim their cash back instead of taking delivery.
    let s = setup();
    let id = open_put(&s);

    s.oracle.set_price(&EXPIRY, &20_000_000_000_000); // ITM at expiry
    s.oracle.set_lastprice(&40_000_000_000_000, &(EXPIRY + 1800)); // rallied since
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 1800);

    assert_eq!(s.vault.settle(&id), symbol_short!("assigned"));
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
