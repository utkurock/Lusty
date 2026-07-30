#![cfg(test)]

use super::reflector::{Asset, PriceData};
use super::{Kind, Limits, LustyVault, LustyVaultClient, MAX_QUOTERS};
use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::{
    contract, contractimpl, symbol_short, token, vec, Address, Env, IntoVal, Symbol, Vec,
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

    /// Empty the live feed — the harness seeds one so positions can be opened,
    /// and the outage tests need it gone again.
    pub fn clear_lastprice(env: Env) {
        env.storage().instance().remove(&symbol_short!("last"));
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
    admin: Address,
}

fn limits(call: i128, put: i128) -> Limits {
    limits_with_expiry(call, put, MAX_EXPIRY_CALL, MAX_EXPIRY_PUT)
}

fn limits_with_expiry(call: i128, put: i128, exp_call: i128, exp_put: i128) -> Limits {
    Limits {
        max_position_call: call,
        max_position_put: put,
        max_expiry_call: exp_call,
        max_expiry_put: exp_put,
        max_premium_bps: MAX_PREMIUM_BPS,
    }
}

fn limits_with_premium_bps(bps: u32) -> Limits {
    Limits {
        max_premium_bps: bps,
        ..limits(MAX_POSITION_CALL, MAX_POSITION_PUT)
    }
}

// Aligned to the mock feed's 300s resolution so EXPIRY normalizes to itself.
const START: u64 = 1_750_000_200;
const EXPIRY: u64 = START + 7 * 86400;
// Strike at oracle scale (14 decimals): $0.25
const STRIKE: i128 = 25_000_000_000_000;
// Live price while positions are being opened — deliberately NOT the strike, so
// a cap that mistakenly valued collateral at the strike would show up.
const SPOT: i128 = 20_000_000_000_000; // $0.20
const COLLATERAL: i128 = 100_0000000; // 100 XLM in stroops
// Cash securing 100 XLM at the $0.25 strike — the put-side mirror of COLLATERAL.
const PUT_COLLATERAL: i128 = 25_0000000;
const PREMIUM: i128 = 5_0000000; // $5 in cash units (7 decimals)
const POOL: i128 = 1_000_0000000; // $1000 pool
const WRITER_XLM: i128 = 1_000_0000000;
// Position caps, set well clear of the fixtures above so only the tests that
// target them ever trip them.
const MAX_POSITION_CALL: i128 = 10_000_0000000;
const MAX_POSITION_PUT: i128 = 10_000_0000000;
const MAX_EXPIRY_CALL: i128 = 100_000_0000000;
const MAX_EXPIRY_PUT: i128 = 100_000_0000000;
// Same idea for the premium ceiling: PREMIUM is 25% of a call's collateral
// value (100 XLM × $0.20) and 20% of a put's, so 50% leaves both clear.
const MAX_PREMIUM_BPS: u32 = 5_000;

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
            vec![&env, quoter.clone()],
            admin.clone(),
            limits(MAX_POSITION_CALL, MAX_POSITION_PUT),
        ),
    );
    let vault = LustyVaultClient::new(&env, &vault_id);
    vault.fund(&funder, &POOL);
    // Opening a call values its collateral at the live price, so the feed has
    // to be up before any position can be written.
    oracle.set_lastprice(&SPOT, &START);

    Setup { env, vault, oracle, token, cash, writer, treasury, quoter, admin }
}

// ── Deposit / premium ───────────────────────────────────────────────

#[test]
fn deposit_escrows_collateral_and_pays_premium_atomically() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
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
        .open(&s.writer, &Kind::Put, &PUT_COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")] // InsufficientPool
fn open_call_rejected_when_pool_cannot_cover_assignment() {
    // One call for 100 XLM at $0.25 owes $25 on assignment; the pool covers
    // forty of those. The forty-first is refused.
    let s = setup();
    token::StellarAssetClient::new(&s.env, &s.token.address).mint(&s.writer, &(COLLATERAL * 41));
    for _ in 0..41 {
        s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &0, &s.quoter);
    }
}

#[test]
fn a_calls_escrow_is_not_lent_to_a_put() {
    // The call writer's 100 XLM sits in the same token the put would be paid
    // in. It backs their position only — a put must bring its own inventory.
    let s = setup();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    assert_eq!(s.token.balance(&s.vault.address), COLLATERAL);

    token::StellarAssetClient::new(&s.env, &s.cash.address).mint(&s.writer, &PUT_COLLATERAL);
    let refused = s.vault.try_open(
        &s.writer,
        &Kind::Put,
        &PUT_COLLATERAL,
        &STRIKE,
        &EXPIRY,
        &PREMIUM,
        &s.quoter,
    );
    assert!(refused.is_err());
}

#[test]
fn open_matches_deposit_for_calls() {
    let s = setup();
    let a = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    let b = s
        .vault
        .open(&s.writer, &Kind::Call, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    assert_eq!(s.vault.position(&a).kind, s.vault.position(&b).kind);
    assert_eq!(s.vault.escrowed(&Kind::Call), COLLATERAL * 2);
}

#[test]
fn settlement_releases_the_escrow() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    assert_eq!(s.vault.escrowed(&Kind::Call), COLLATERAL);

    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);

    assert_eq!(s.vault.escrowed(&Kind::Call), 0);
}

#[test]
fn ids_increment() {
    let s = setup();
    let a = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    let b = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    assert_eq!((a, b), (0, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // InvalidAmount
fn deposit_rejects_zero_amount() {
    let s = setup();
    s.vault.deposit(&s.writer, &0, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // InvalidExpiry
fn deposit_rejects_past_expiry() {
    let s = setup();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &(START - 1), &PREMIUM, &s.quoter);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")] // InvalidPremium
fn deposit_rejects_negative_premium() {
    let s = setup();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &-1, &s.quoter);
}

#[test]
#[should_panic] // pool can't cover the premium → whole deposit fails
fn deposit_fails_closed_when_pool_short() {
    let s = setup();
    // Put the premium ceiling out of the way — 10,000 XLM at $0.20 backs a
    // $2,000 premium at 100% — so the pool is the only thing left to fail on.
    s.vault.set_limits(&limits_with_premium_bps(10_000));
    token::StellarAssetClient::new(&s.env, &s.token.address).mint(&s.writer, &MAX_POSITION_CALL);
    s.vault
        .deposit(&s.writer, &MAX_POSITION_CALL, &STRIKE, &EXPIRY, &(POOL + 1), &s.quoter);
}

// ── Settlement ──────────────────────────────────────────────────────

#[test]
fn settle_otm_returns_collateral_no_cash() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);

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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);

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
        .open(&s.writer, &Kind::Put, &PUT_COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter)
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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);

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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &expiry, &PREMIUM, &s.quoter);
    s.oracle.set_price(&EXPIRY, &30_000_000_000_000); // EXPIRY % 300 == 0
    s.env.ledger().with_mut(|l| l.timestamp = expiry + 60);

    assert_eq!(s.vault.settle(&id), symbol_short!("assigned"));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // NotExpired
fn settle_rejects_before_expiry() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY - 1);
    s.vault.settle(&id);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // AlreadySettled
fn settle_rejects_double_settlement() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);
    s.vault.settle(&id);
}

#[test]
fn settle_falls_back_to_fresh_lastprice() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    // The feed goes dark after the position is written: no record at expiry and
    // nothing live to fall back to.
    s.oracle.clear_lastprice();
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
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
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
            vec![&env, quoter.clone()],
            quoter.clone(),
            limits(MAX_POSITION_CALL, MAX_POSITION_PUT),
        ),
    );
    let vault = LustyVaultClient::new(&env, &vault_id);
    vault.deposit(&writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &quoter);
}

// ── On-chain verifiability ──────────────────────────────────────────

#[test]
fn an_owners_positions_are_discoverable_from_state() {
    let s = setup();
    let other = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token.address).mint(&other, &COLLATERAL);

    let a = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    let b = s.vault.deposit(&other, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    let c = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);

    assert_eq!(s.vault.position_count(&s.writer), 2);
    assert_eq!(s.vault.position_count(&other), 1);
    // Oldest first, and never another writer's position.
    assert_eq!(s.vault.positions_of(&s.writer, &0, &10), vec![&s.env, a, c]);
    assert_eq!(s.vault.positions_of(&other, &0, &10), vec![&s.env, b]);
    // Paging holds at the edges.
    assert_eq!(s.vault.positions_of(&s.writer, &1, &10), vec![&s.env, c]);
    assert_eq!(s.vault.positions_of(&s.writer, &9, &10).len(), 0);
}

#[test]
fn settled_positions_stay_in_the_owners_history() {
    let s = setup();
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);

    assert_eq!(s.vault.positions_of(&s.writer, &0, &10), vec![&s.env, id]);
    assert!(s.vault.position(&id).settled);
}

#[test]
fn stats_expose_the_solvency_the_contract_enforces() {
    let s = setup();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);

    let st = s.vault.stats();
    assert_eq!(st.escrowed_call, COLLATERAL);
    assert_eq!(st.escrowed_put, 0);
    assert_eq!(st.owed_call, COLLATERAL * STRIKE / 10i128.pow(14));
    assert_eq!(st.owed_put, 0);
    assert_eq!(st.underlying_balance, COLLATERAL);
    assert_eq!(st.cash_balance, POOL - PREMIUM);
    assert_eq!(st.next_id, 1);
    // The guard, restated from the outside: free cash covers what calls owe.
    assert!(st.cash_balance - st.escrowed_put >= st.owed_call);
}

// ── Limits ──────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // PositionTooLarge
fn open_rejects_a_position_over_the_size_cap() {
    let s = setup();
    token::StellarAssetClient::new(&s.env, &s.token.address)
        .mint(&s.writer, &(MAX_POSITION_CALL + 1));
    s.vault
        .deposit(&s.writer, &(MAX_POSITION_CALL + 1), &STRIKE, &EXPIRY, &0, &s.quoter);
}

#[test]
fn admin_can_tighten_the_size_cap() {
    let s = setup();
    s.vault.set_limits(&limits(COLLATERAL - 1, MAX_POSITION_PUT));
    assert_eq!(s.vault.limits().max_position_call, COLLATERAL - 1);

    let refused = s
        .vault
        .try_deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    assert!(refused.is_err());
}

#[test]
#[should_panic] // admin did not sign
fn set_limits_requires_the_admin() {
    let s = setup();
    // Re-arm auth mocking to cover the writer only — the admin is not signing.
    s.env.mock_auths(&[MockAuth {
        address: &s.writer,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "set_limits",
            args: (limits(1, 1),).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.vault.set_limits(&limits(1, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // InvalidLimit
fn set_limits_rejects_a_zero_cap() {
    let s = setup();
    s.vault.set_limits(&limits(0, MAX_POSITION_PUT));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // InvalidLimit
fn set_limits_rejects_an_expiry_cap_below_the_position_cap() {
    let s = setup();
    s.vault.set_limits(&limits_with_expiry(
        COLLATERAL,
        MAX_POSITION_PUT,
        COLLATERAL - 1,
        MAX_EXPIRY_PUT,
    ));
}

#[test]
fn exposure_accumulates_per_expiry_and_caps_the_book() {
    // Room for two positions on this expiry, and no more — even though each
    // one is comfortably inside the position cap.
    let s = setup();
    s.vault.set_limits(&limits_with_expiry(
        COLLATERAL,
        MAX_POSITION_PUT,
        COLLATERAL * 2,
        MAX_EXPIRY_PUT,
    ));

    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &0, &s.quoter);
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &0, &s.quoter);
    assert_eq!(s.vault.exposure(&Kind::Call, &EXPIRY), COLLATERAL * 2);

    let refused = s
        .vault
        .try_deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &0, &s.quoter);
    assert!(refused.is_err());

    // A different expiry has its own budget, so the vault stays open for business.
    let later = EXPIRY + 7 * 86400;
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &later, &0, &s.quoter);
    assert_eq!(s.vault.exposure(&Kind::Call, &later), COLLATERAL);
}

#[test]
fn settlement_frees_the_expiry_budget() {
    let s = setup();
    s.vault.set_limits(&limits_with_expiry(
        COLLATERAL,
        MAX_POSITION_PUT,
        COLLATERAL,
        MAX_EXPIRY_PUT,
    ));
    let id = s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &0, &s.quoter);

    s.oracle.set_price(&EXPIRY, &23_000_000_000_000);
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    s.vault.settle(&id);

    assert_eq!(s.vault.exposure(&Kind::Call, &EXPIRY), 0);
}

// ── Premium ceiling ─────────────────────────────────────────────────
//
// The quoter's signature is what sets the premium, so this ceiling is the only
// thing standing between a compromised pricing key and the cash pool.

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // PremiumTooHigh
fn premium_ceiling_caps_a_call_against_collateral_value() {
    let s = setup();
    // 100 XLM at $0.20 is $20 of collateral; at 10% the vault will pay $2.
    s.vault.set_limits(&limits_with_premium_bps(1_000));
    s.vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &2_0000001, &s.quoter);
}

#[test]
fn a_premium_exactly_at_the_ceiling_is_accepted() {
    let s = setup();
    s.vault.set_limits(&limits_with_premium_bps(1_000));
    let cap = COLLATERAL * SPOT / 10i128.pow(14) / 10; // $2.00
    assert_eq!(cap, 2_0000000);

    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &cap, &s.quoter);
    assert_eq!(s.cash.balance(&s.writer), cap);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // PremiumTooHigh
fn premium_ceiling_caps_a_put_against_its_cash_collateral() {
    let s = setup();
    // A put's collateral is already cash: $25 escrowed, 10% → $2.50.
    s.vault.set_limits(&limits_with_premium_bps(1_000));
    token::StellarAssetClient::new(&s.env, &s.cash.address).mint(&s.writer, &PUT_COLLATERAL);
    let stock = Address::generate(&s.env);
    token::StellarAssetClient::new(&s.env, &s.token.address).mint(&stock, &COLLATERAL);
    s.vault.fund_underlying(&stock, &COLLATERAL);
    s.vault
        .open(&s.writer, &Kind::Put, &PUT_COLLATERAL, &STRIKE, &EXPIRY, &2_5000001, &s.quoter);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // PremiumTooHigh
fn the_ceiling_is_priced_at_spot_not_at_the_quoters_strike() {
    // The attack the ceiling exists to stop. A quoter that could value
    // collateral at its own strike would escrow one stroop of XLM, name a
    // strike of $10,000, and buy itself a premium off a $0.001 position. Spot
    // pricing makes that stroop worth 0.00000002 dollars, and the premium with
    // it — the quoter cannot inflate what it is not allowed to set.
    let s = setup();
    let absurd_strike = 10_000i128 * 10i128.pow(14);
    s.vault.deposit(&s.writer, &1, &absurd_strike, &EXPIRY, &1_0000000, &s.quoter);
}

#[test]
fn admin_can_tighten_the_premium_ceiling() {
    let s = setup();
    // PREMIUM ($5 on $20 of collateral) clears the default ceiling…
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    // …and stops clearing it once the admin pulls the ceiling under it.
    s.vault.set_limits(&limits_with_premium_bps(1_000));
    assert_eq!(s.vault.limits().max_premium_bps, 1_000);

    let refused = s
        .vault
        .try_deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
    assert!(refused.is_err());
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // InvalidLimit
fn set_limits_rejects_a_ceiling_above_the_collateral() {
    // Paying out more than was escrowed is a loss booked at the moment of
    // writing, so 100% is as high as the ceiling itself may go.
    let s = setup();
    s.vault.set_limits(&limits_with_premium_bps(10_001));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // InvalidLimit
fn set_limits_rejects_a_zero_premium_ceiling() {
    let s = setup();
    s.vault.set_limits(&limits_with_premium_bps(0));
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")] // StalePrice
fn a_call_cannot_be_written_against_a_stale_feed() {
    // Valuing collateral needs a current price. A stale feed blocks the write
    // rather than size the ceiling off a price that no longer holds.
    let s = setup();
    s.env.ledger().with_mut(|l| l.timestamp = START + 7200);
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // NoPrice
fn a_call_cannot_be_written_against_an_empty_feed() {
    let s = setup();
    s.oracle.clear_lastprice();
    s.vault.deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
}

#[test]
fn a_put_needs_no_price_to_value_its_cash_collateral() {
    // The put leg keeps trading through a feed outage: its collateral is cash,
    // already denominated in the token the premium is paid in.
    let s = setup();
    s.oracle.clear_lastprice();
    let id = open_put(&s);
    assert_eq!(s.vault.position(&id).premium, PREMIUM);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // PremiumTooHigh
fn the_ceiling_is_checked_before_any_collateral_moves() {
    // A rejected quote must leave the writer's balances untouched, which the
    // failed transaction guarantees; what this pins is that the check does not
    // depend on the transfer having happened first.
    let s = setup();
    s.vault.set_limits(&limits_with_premium_bps(1_000));
    s.vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &POOL, &s.quoter);
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
                s.quoter.clone(),
            )
                .into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &s.quoter);
}

// ── Quoter set ──────────────────────────────────────────────────────
// The premium is the only number a writer cannot set alone, so the set of keys
// allowed to sign one is the vault's day-to-day trust boundary. What matters:
// it is enforced on every write, only the admin can change it, and changing it
// never reaches backwards into positions already written.

#[test]
#[should_panic(expected = "Error(Contract, #15)")] // UnknownQuoter
fn a_key_outside_the_set_cannot_price_a_position() {
    let s = setup();
    let impostor = Address::generate(&s.env);
    // Auth is mocked for everyone, so the only thing standing between this
    // address and a signed premium is membership of the set.
    s.vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &impostor);
}

#[test]
fn an_added_quoter_can_price_immediately() {
    let s = setup();
    let second = Address::generate(&s.env);
    s.vault.add_quoter(&second);

    assert!(s.vault.is_quoter(&second));
    assert_eq!(s.vault.quoters().len(), 2);
    let id = s
        .vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &second);
    assert_eq!(s.vault.position(&id).premium, PREMIUM);
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")] // UnknownQuoter
fn a_removed_quoter_can_no_longer_price() {
    let s = setup();
    let second = Address::generate(&s.env);
    s.vault.add_quoter(&second);
    s.vault.remove_quoter(&second);
    assert!(!s.vault.is_quoter(&second));

    s.vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &second);
}

#[test]
fn revoking_a_quoter_leaves_the_positions_it_priced_untouched() {
    // The compromise response has to be safe to reach for. Revocation closes
    // the door to new quotes; it must not strand collateral already escrowed
    // behind a key that is now untrusted — settlement never consults a quoter.
    let s = setup();
    let compromised = Address::generate(&s.env);
    s.vault.add_quoter(&compromised);
    let id = s
        .vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &compromised);

    s.vault.remove_quoter(&compromised);

    s.oracle.set_price(&EXPIRY, &23_000_000_000_000); // below strike → kept
    s.env.ledger().with_mut(|l| l.timestamp = EXPIRY + 60);
    assert_eq!(s.vault.settle(&id), symbol_short!("kept"));
    assert_eq!(s.token.balance(&s.writer), WRITER_XLM);
    assert_eq!(s.cash.balance(&s.writer), PREMIUM);
}

#[test]
fn rotation_never_leaves_the_vault_unable_to_quote() {
    // Add-then-remove, the order the contract forces by refusing to empty the
    // set: there is no ledger in between where a writer would be turned away.
    let s = setup();
    let incoming = Address::generate(&s.env);

    s.vault.add_quoter(&incoming);
    s.vault.remove_quoter(&s.quoter);

    assert_eq!(s.vault.quoters(), vec![&s.env, incoming.clone()]);
    assert!(!s.vault.is_quoter(&s.quoter));
    s.vault
        .deposit(&s.writer, &COLLATERAL, &STRIKE, &EXPIRY, &PREMIUM, &incoming);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")] // LastQuoter
fn the_last_quoter_cannot_be_removed() {
    // Emptying the set would close the vault to new writers with no way back
    // in that does not go through the admin again.
    let s = setup();
    s.vault.remove_quoter(&s.quoter);
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")] // QuoterExists
fn a_quoter_cannot_be_added_twice() {
    // A duplicate would survive its own removal — one `remove_quoter` would
    // look like a revocation while leaving the key able to price.
    let s = setup();
    s.vault.add_quoter(&s.quoter);
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")] // UnknownQuoter
fn removing_a_key_that_was_never_a_quoter_is_refused() {
    let s = setup();
    s.vault.remove_quoter(&Address::generate(&s.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")] // TooManyQuoters
fn the_set_is_bounded() {
    // Every member can price up to the premium ceiling, so an unbounded set is
    // an unbounded trust surface — and eventually an oversized ledger entry.
    let s = setup();
    for _ in 1..MAX_QUOTERS {
        s.vault.add_quoter(&Address::generate(&s.env));
    }
    assert_eq!(s.vault.quoters().len(), MAX_QUOTERS);
    s.vault.add_quoter(&Address::generate(&s.env));
}

#[test]
#[should_panic] // only the writer's auth is mocked → admin auth missing
fn only_the_admin_can_change_the_quoter_set() {
    let s = setup();
    let outsider = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.writer,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "add_quoter",
            args: (outsider.clone(),).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.vault.add_quoter(&outsider);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")] // LastQuoter
fn the_constructor_refuses_an_empty_set() {
    register_vault_with_quoters(Vec::new(&Env::default()));
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")] // QuoterExists
fn the_constructor_refuses_a_duplicate_set() {
    let env = Env::default();
    let quoter = Address::generate(&env);
    register_vault_with_quoters(vec![&env, quoter.clone(), quoter]);
}

/// Deploy a bare vault with a given quoter set, for the constructor's own
/// validation — `setup()` cannot express a set it would refuse to store.
fn register_vault_with_quoters(quoters: Vec<Address>) {
    let env = quoters.env().clone();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let usdc = env.register_stellar_asset_contract_v2(admin.clone());
    let oracle_id = env.register(MockOracle, ());
    env.register(
        LustyVault,
        (
            oracle_id,
            Symbol::new(&env, "XLM"),
            sac.address(),
            usdc.address(),
            Address::generate(&env),
            quoters,
            admin,
            limits(MAX_POSITION_CALL, MAX_POSITION_PUT),
        ),
    );
}
