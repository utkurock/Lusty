// The declared underlyings.
// =========================
// Data, not code. Every asset the vault lists is written here in the shape
// schema.ts defines, and listing another one means adding an entry — no type
// to widen, no branch to extend, no env key read from somewhere else.
//
// Order is the order surfaces list them in.

import type {
  AssetDeclaration,
  ExpiryParams,
  InlinedEnv,
  StrikeParams,
} from './schema'

/**
 * Every `NEXT_PUBLIC_*` key the declarations below name, written out literally
 * so the bundler can substitute it into the browser build.
 *
 * It has to be spelled out here. The bundler rewrites the public keys it can
 * see in the source, and a declaration names its keys as data, which it cannot
 * see. Leave one out and that asset works on the server and is gated in the
 * browser — the page renders and then disagrees with itself on hydration.
 *
 * So: **an asset declared with a new `NEXT_PUBLIC_` key adds it here too.**
 * `asset-browser-env.test.ts` fails if one is missing, because nothing else
 * can catch it: the test runner and `next build` both have a real
 * `process.env`, and only the browser does not.
 *
 * Server-only keys stay out of this. They have never reached the browser, and
 * a cap that is not public falls back to its default there as it always has.
 */
export const BROWSER_ENV: InlinedEnv = {
  NEXT_PUBLIC_VAULT_CONTRACT: process.env.NEXT_PUBLIC_VAULT_CONTRACT,
  NEXT_PUBLIC_XLM_CONTRACT: process.env.NEXT_PUBLIC_XLM_CONTRACT,
  NEXT_PUBLIC_LUSD_CONTRACT: process.env.NEXT_PUBLIC_LUSD_CONTRACT,
  NEXT_PUBLIC_VAULT_CONTRACT_BTC: process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC,
  NEXT_PUBLIC_BTC_CONTRACT: process.env.NEXT_PUBLIC_BTC_CONTRACT,
  NEXT_PUBLIC_BTC_ANCHOR_CODE: process.env.NEXT_PUBLIC_BTC_ANCHOR_CODE,
  NEXT_PUBLIC_BTC_ANCHOR_ISSUER: process.env.NEXT_PUBLIC_BTC_ANCHOR_ISSUER,
  NEXT_PUBLIC_VAULT_CONTRACT_ETH: process.env.NEXT_PUBLIC_VAULT_CONTRACT_ETH,
  NEXT_PUBLIC_ETH_CONTRACT: process.env.NEXT_PUBLIC_ETH_CONTRACT,
  NEXT_PUBLIC_ETH_ANCHOR_CODE: process.env.NEXT_PUBLIC_ETH_ANCHOR_CODE,
  NEXT_PUBLIC_ETH_ANCHOR_ISSUER: process.env.NEXT_PUBLIC_ETH_ANCHOR_ISSUER,
}

// Premiums are paid in one cash today, and both books escrow puts in it. Named
// once so the two declarations cannot drift apart, and still declared per
// asset so an asset settling in something else stays a config change.
const LUSD_SAC = {
  env: 'NEXT_PUBLIC_LUSD_CONTRACT',
  fallback: 'CDTMNV7F7P3LUH6LLBTXY4EQYBUYGVGYRC7P73HMFV5PXLO5NE6A74QB',
} as const

// The ladder lib/pricing has always used, written down as a parameter instead
// of a module constant. Both assets declare the same rungs because that is
// what is in force today, not because a ladder has to be shared — M2-03 is
// where the ladder is derived from these and the two can diverge.
const DEFAULT_STRIKES: StrikeParams = {
  callOtm: [1.02, 1.06, 1.12, 1.2],
  putOtm: [0.98, 0.94, 0.88, 0.8],
  tickFraction: 0.01,
}

// Likewise the Friday ladder in lib/expiries: three rolling expiries a week
// apart, nothing written inside two days of settlement. `openExpiries` is the
// divisor that turns a monthly capacity into the per-expiry bucket reconciled
// against the contract, so it is per asset from here on.
const DEFAULT_EXPIRIES: ExpiryParams = {
  openExpiries: 3,
  minDaysToExpiry: 2,
  tenorDays: 7,
}

export const DECLARATIONS: AssetDeclaration[] = [
  {
    symbol: 'XLM',
    name: 'Stellar Lumens',
    slug: 'xlm',
    icon: '✦',
    logo: '/xlm.png',
    contracts: {
      // Keeps its Tranche 1 spelling: it named the only instance there was.
      vault: { env: ['NEXT_PUBLIC_VAULT_CONTRACT', 'VAULT_CONTRACT'], fallback: '' },
      token: {
        env: 'NEXT_PUBLIC_XLM_CONTRACT',
        fallback: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      },
      cash: LUSD_SAC,
    },
    feedSymbol: { env: 'REFLECTOR_FEED_SYMBOL', fallback: 'XLM' },
    binanceSymbol: 'XLMUSDT',
    coingeckoId: 'stellar',
    bitstampPair: 'xlmusd',
    collateral: { kind: 'native' },
    unitDecimals: 7,
    displayDecimals: 2,
    strike: DEFAULT_STRIKES,
    expiry: DEFAULT_EXPIRIES,
    envelope: {
      minSize: { env: 'VAULT_MIN_SIZE_XLM', fallback: 100 },
      maxSize: { env: 'VAULT_MAX_SIZE_XLM', fallback: 10_000 },
      userEpochCall: { env: 'MAX_USER_EPOCH_CALL_XLM', fallback: 10_000 },
      maxSizeCash: { env: 'VAULT_MAX_SIZE_CASH_XLM', fallback: 10_000 },
      userEpochPutUsd: { env: 'MAX_USER_EPOCH_PUT_USD', fallback: 10_000 },
      callMonthlyCap: { env: 'VAULT_CALL_MONTHLY_CAP_XLM', fallback: 1_500_000 },
      putMonthlyCapUsd: { env: 'VAULT_PUT_MONTHLY_CAP_USD', fallback: 150_000 },
    },
    // Read off CBJZGTCF…UCJZ on 2026-09-15. The expiry caps are ten times the
    // envelope's own per-expiry put bucket, which is deliberate: the contract
    // is the outer bound, the desk quotes inside it.
    onchainLimits: {
      maxPositionCall: 10_000,
      maxPositionPut: 10_000,
      maxExpiryCall: 500_000,
      maxExpiryPut: 500_000,
      maxPremiumBps: 2_000,
    },
  },
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    slug: 'btc',
    icon: '₿',
    logo: '/btc.png',
    // No fallback on the vault: falling back to XLM's would put BTC's money in
    // XLM's contract.
    contracts: {
      vault: { env: 'NEXT_PUBLIC_VAULT_CONTRACT_BTC', fallback: '' },
      token: { env: 'NEXT_PUBLIC_BTC_CONTRACT', fallback: '' },
      cash: LUSD_SAC,
    },
    feedSymbol: { env: 'REFLECTOR_FEED_SYMBOL_BTC', fallback: 'BTC' },
    binanceSymbol: 'BTCUSDT',
    coingeckoId: 'bitcoin',
    bitstampPair: 'btcusd',
    // The anchor that issues the wrapped BTC the vault accepts as collateral.
    // On testnet that is LBTC, issued by this repo (scripts/mint-lbtc.mjs) for
    // the same reason LUSD is: nobody anchors wrapped BTC to a network whose
    // BTC has no reserve behind it. Settlement is unaffected — the price comes
    // from the Reflector BTC/USD feed, never from the issuer. Mainnet replaces
    // this key with a real anchor's, and nothing else changes.
    collateral: {
      kind: 'issued',
      code: { env: 'NEXT_PUBLIC_BTC_ANCHOR_CODE', fallback: 'BTC' },
      issuer: { env: 'NEXT_PUBLIC_BTC_ANCHOR_ISSUER', fallback: null },
    },
    unitDecimals: 7,
    displayDecimals: 6,
    strike: DEFAULT_STRIKES,
    expiry: DEFAULT_EXPIRIES,
    envelope: {
      minSize: { env: 'VAULT_MIN_SIZE_BTC', fallback: 0.001 },
      // The deployed instance's own limits: 0.05 BTC a call position, 1,500
      // cash a put position. XLM's 10,000 would read as 10,000 BTC.
      maxSize: { env: 'VAULT_MAX_SIZE_BTC', fallback: 0.05 },
      userEpochCall: { env: 'MAX_USER_EPOCH_CALL_BTC', fallback: 0.05 },
      maxSizeCash: { env: 'VAULT_MAX_SIZE_CASH_BTC', fallback: 1_500 },
      userEpochPutUsd: { env: 'MAX_USER_EPOCH_PUT_USD_BTC', fallback: 1_500 },
      // BTC keeps its own books: its capacity is not a share of XLM's, and
      // filling one leaves the other untouched.
      callMonthlyCap: { env: 'VAULT_CALL_MONTHLY_CAP_BTC', fallback: 5 },
      putMonthlyCapUsd: { env: 'VAULT_PUT_MONTHLY_CAP_USD_BTC', fallback: 150_000 },
    },
    // Read off CBQEACXA…MVEU on 2026-09-15, the values scripts/deploy-vault.mjs
    // constructed it with.
    onchainLimits: {
      maxPositionCall: 0.05,
      maxPositionPut: 1_500,
      maxExpiryCall: 5,
      maxExpiryPut: 150_000,
      maxPremiumBps: 2_000,
    },
  },
  // The third book, and the only one added the way the framework is supposed
  // to take one: this entry is the whole change. No type was widened, no branch
  // extended, no rail taught a new symbol — M2-01 opened `UnderlyingSymbol`, and
  // this is what that bought.
  //
  // It ships gated on purpose. The Reflector ETH/USD feed is live on testnet at
  // the same scale and cadence as the other two, so the price half needs
  // nothing; what is missing is an instance to settle in and an anchor to
  // escrow. Both are env keys, and M2-02 reports exactly those two as the
  // reasons — which is the proof worth having. Listing ETH is a deploy and two
  // values, not a commit.
  {
    symbol: 'ETH',
    name: 'Ethereum',
    slug: 'eth',
    icon: 'Ξ',
    logo: '/eth.svg',
    contracts: {
      vault: { env: 'NEXT_PUBLIC_VAULT_CONTRACT_ETH', fallback: '' },
      token: { env: 'NEXT_PUBLIC_ETH_CONTRACT', fallback: '' },
      cash: LUSD_SAC,
    },
    feedSymbol: { env: 'REFLECTOR_FEED_SYMBOL_ETH', fallback: 'ETH' },
    binanceSymbol: 'ETHUSDT',
    coingeckoId: 'ethereum',
    bitstampPair: 'ethusd',
    collateral: {
      kind: 'issued',
      code: { env: 'NEXT_PUBLIC_ETH_ANCHOR_CODE', fallback: 'ETH' },
      issuer: { env: 'NEXT_PUBLIC_ETH_ANCHOR_ISSUER', fallback: null },
    },
    unitDecimals: 7,
    // Five places is about three cents at four thousand dollars — the same
    // resolution BTC's six buys at seventy-seven thousand.
    displayDecimals: 5,
    strike: DEFAULT_STRIKES,
    expiry: DEFAULT_EXPIRIES,
    // Sized in ETH, at roughly the dollar scale BTC's book carries. Nothing is
    // deployed against these yet, so they are the numbers an instance would be
    // constructed with rather than a record of one that was.
    envelope: {
      minSize: { env: 'VAULT_MIN_SIZE_ETH', fallback: 0.01 },
      maxSize: { env: 'VAULT_MAX_SIZE_ETH', fallback: 1 },
      userEpochCall: { env: 'MAX_USER_EPOCH_CALL_ETH', fallback: 1 },
      maxSizeCash: { env: 'VAULT_MAX_SIZE_CASH_ETH', fallback: 1_500 },
      userEpochPutUsd: { env: 'MAX_USER_EPOCH_PUT_USD_ETH', fallback: 1_500 },
      callMonthlyCap: { env: 'VAULT_CALL_MONTHLY_CAP_ETH', fallback: 100 },
      putMonthlyCapUsd: { env: 'VAULT_PUT_MONTHLY_CAP_USD_ETH', fallback: 150_000 },
    },
    // What an instance would be deployed with, not what one was read back as —
    // there is no ETH instance. M2-05 reconciles this against the contract
    // before the book is quoted, and a gated book is never quoted, so nothing
    // reads these until the deploy makes them true.
    onchainLimits: {
      maxPositionCall: 1,
      maxPositionPut: 1_500,
      maxExpiryCall: 34,
      maxExpiryPut: 150_000,
      maxPremiumBps: 2_000,
    },
  },
]
