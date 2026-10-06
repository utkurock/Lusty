// Attack the deployed books, and assert they refuse.
//
//   node scripts/adversarial/refuse.mjs           # every book, every attempt
//   node scripts/adversarial/refuse.mjs BTC       # one book
//
// Every attempt here is SIMULATED, never submitted. That is not a weaker test
// than sending it: Soroban decides a call's outcome during simulation, so a
// refusal shows up as the contract's own error code before a transaction is
// ever signed. It costs nothing, needs no key, needs no funded account, and
// runs against the live instances — which is what makes it worth running on a
// schedule rather than once.
//
// What it cannot cover is the half that needs a signature and a balance:
// opening a position, escrowing collateral, taking a co-signature from the
// quoter. Those attempts are listed at the bottom as gaps rather than quietly
// left out, because a harness that reports "all clear" over an unrun class is
// worse than one that reports nothing.
//
// Each attempt names the class it belongs to in docs/ADVERSARIAL.md §3 and the
// contract error it must come back with. An attempt that SUCCEEDS is a finding,
// and this exits non-zero when one does.

import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  StrKey,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Published addresses below are the defaults.
}

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org'
const PASSPHRASE = Networks.TESTNET
const PROBE = 'GCXVANOIFHM7IAAZTDEEOYW7WUDO7ETVJYVEO74LA23JSXQJP4TAJVUX'
const server = new rpc.Server(RPC_URL)

const VAULTS = {
  XLM:
    process.env.NEXT_PUBLIC_VAULT_CONTRACT ||
    'CBJZGTCF2PJVHX2BNFTFZ2L2LX6DWD5JMTLHNCVYTSOD3BLVSXZRUCJZ',
  BTC:
    process.env.NEXT_PUBLIC_VAULT_CONTRACT_BTC ||
    'CBQEACXAOZMCU3YOUWDC3MWXDSQBWKNGKBA6XMRPY5D5JQRNP2HLMVEU',
}

// contracts/vault/src/lib.rs. A refusal names one of these, and which one it
// names is the assertion: "it failed" is not the same claim as "it refused for
// the reason it should have".
const ERRORS = {
  1: 'InvalidAmount',
  2: 'InvalidStrike',
  3: 'InvalidExpiry',
  4: 'PositionNotFound',
  5: 'AlreadySettled',
  6: 'NotExpired',
  7: 'NoPrice',
  8: 'StalePrice',
  9: 'InvalidPremium',
  10: 'InsufficientPool',
  11: 'PositionTooLarge',
  12: 'InvalidLimit',
  13: 'ExpiryFull',
  14: 'PremiumTooHigh',
  15: 'UnknownQuoter',
  16: 'QuoterExists',
  17: 'LastQuoter',
  18: 'TooManyQuoters',
}

const u64 = (v) => nativeToScVal(BigInt(v), { type: 'u64' })
const u32 = (v) => nativeToScVal(v, { type: 'u32' })
const i128 = (v) => nativeToScVal(BigInt(v), { type: 'i128' })

/** A `Limits` struct: a Soroban map, keyed by symbol, in sorted key order. */
function limitsScVal(posCall, posPut, expCall, expPut, bps) {
  const entry = (key, val) =>
    new xdr.ScMapEntry({ key: nativeToScVal(key, { type: 'symbol' }), val })
  return xdr.ScVal.scvMap([
    entry('max_expiry_call', i128(expCall)),
    entry('max_expiry_put', i128(expPut)),
    entry('max_position_call', i128(posCall)),
    entry('max_position_put', i128(posPut)),
    entry('max_premium_bps', u32(bps)),
  ])
}

/**
 * Every address a simulated call says it needs a signature from.
 *
 * This is the part of simulation that answers an authorization question, and it
 * is why `require_auth` cannot be tested by expecting an error: simulation
 * RECORDS the signatures a call would need rather than refusing for their
 * absence. A call whose auth is missing simulates cleanly and fails at
 * submission. So the assertion is not "it errored" — it is "it demanded the
 * admin's signature", which is the same claim and is checkable for free.
 */
function requiredSigners(sim) {
  const out = []
  for (const entry of sim.result?.auth ?? []) {
    const creds = entry.credentials()
    if (creds.switch().name !== 'sorobanCredentialsAddress') continue
    const addr = creds.address().address()
    if (addr.switch().name === 'scAddressTypeAccount') {
      out.push(Keypair.fromPublicKey(
        StrKey.encodeEd25519PublicKey(addr.accountId().ed25519()),
      ).publicKey())
    }
  }
  return out
}

/** Simulate one invocation and say what came back. Never submits. */
async function attempt(contractId, method, args, source = PROBE) {
  const account = await server.getAccount(source)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build()
  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    // "Error(Contract, #6)" — a discriminant, but whose? A call that reaches a
    // token contract fails with the TOKEN's enum, and reading that against the
    // vault's would name the wrong rule with total confidence. So the code is
    // only interpreted when the error names this contract.
    const code = /Error\(Contract, #(\d+)\)/.exec(sim.error)?.[1]
    const ours = sim.error.includes(contractId)
    return {
      refused: true,
      code: code ? Number(code) : null,
      fromVault: ours,
      raw: sim.error,
    }
  }
  return { refused: false, value: scValToNative(sim.result.retval), signers: requiredSigners(sim) }
}

/**
 * Find a position to attack, by reading rather than assuming. `settle` refuses
 * on three different grounds and each needs a different position, so the
 * attempts below are built from whatever the book actually holds.
 */
async function survey(contractId) {
  const stats = await attempt(contractId, 'stats', [])
  if (stats.refused) throw new Error(`stats() refused: ${stats.raw}`)
  const nextId = Number(stats.value.next_id)
  const now = Math.floor(Date.now() / 1000)

  let settled = null
  let open = null
  // Newest first: an open position is likelier near the top, and this bounds
  // the walk on a book that has been running a while.
  for (let id = nextId - 1; id >= 0 && (settled === null || open === null); id--) {
    const p = await attempt(contractId, 'position', [u64(id)])
    if (p.refused) continue
    if (p.value.settled && settled === null) settled = id
    if (!p.value.settled && Number(p.value.expiry) > now && open === null) open = id
  }
  return { nextId, settled, open }
}

async function run(symbol) {
  const vault = VAULTS[symbol]
  console.log(`\n── ${symbol} — ${vault}`)

  const { nextId, settled, open } = await survey(vault)
  const cfg = await attempt(vault, 'config', [])
  const quoters = await attempt(vault, 'quoters', [])
  const admin = cfg.value.admin
  const quoter = quoters.value[0]
  console.log(`   ${nextId} positions written; settled #${settled ?? '—'}, unexpired #${open ?? '—'}`)
  console.log(`   admin ${admin}\n`)

  // An account that is nobody: not the admin, not a quoter, not a writer.
  // Generated per run so no attempt can pass by having been whitelisted once.
  const stranger = Keypair.random().publicKey()

  /**
   * [class, what it tries, invocation, expectation]
   *
   * The expectation is either the vault error it must refuse with, or
   * `{ auth: address }` — the signature it must demand. The second form is for
   * the admin-gated entrypoints, where simulation records the requirement
   * instead of rejecting for its absence (see `requiredSigners`).
   */
  const attempts = [
    [
      8,
      'settle a position that is already settled',
      settled === null ? null : ['settle', [u64(settled)]],
      'AlreadySettled',
    ],
    [
      6,
      'settle a position before its expiry',
      open === null ? null : ['settle', [u64(open)]],
      'NotExpired',
    ],
    [
      10,
      'settle an id this book never issued',
      ['settle', [u64(nextId + 10_000)]],
      'PositionNotFound',
    ],
    [
      10,
      'read an id this book never issued',
      ['position', [u64(nextId + 10_000)]],
      'PositionNotFound',
    ],
    [
      11,
      'set_limits to anything at all',
      ['set_limits', [limitsScVal(1n, 1n, 1n, 1n, 2000)]],
      { auth: admin },
    ],
    [
      11,
      'add a quoter of your own',
      ['add_quoter', [nativeToScVal(stranger, { type: 'address' })]],
      { auth: admin },
    ],
    [
      11,
      'remove the quoter the vault actually has',
      ['remove_quoter', [nativeToScVal(quoter, { type: 'address' })]],
      { auth: admin },
    ],
    [
      4,
      'raise the premium ceiling past the collateral behind it',
      // Even holding the admin key: 10,001 bps is a premium worth more than
      // what secures it, which is a loss taken at the moment of writing. The
      // contract bounds its own admin here, and that is the assertion.
      ['set_limits', [limitsScVal(1n, 1n, 1n, 1n, 10_001)]],
      'InvalidLimit',
    ],
    [
      4,
      'set an expiry cap below the position cap it is supposed to contain',
      ['set_limits', [limitsScVal(100n, 1n, 1n, 1n, 2000)]],
      'InvalidLimit',
    ],
  ]

  let findings = 0
  for (const [klass, what, call, expected] of attempts) {
    if (call === null) {
      console.log(`   SKIP  §${String(klass).padEnd(2)} ${what}`)
      console.log(`         — this book has no position in the state the attempt needs`)
      continue
    }
    const [method, args] = call
    const r = await attempt(vault, method, args)
    const label = `§${String(klass).padEnd(2)} ${what}`

    // "It must demand a signature from X."
    if (typeof expected === 'object') {
      if (r.refused) {
        // Refusing outright is at least as strong as demanding a signature, so
        // this is not a finding — but say which, because the two are different
        // guarantees and a reader should not have to assume.
        console.log(`   ok    ${label}`)
        console.log(`         refused before reaching auth: ${describe(r)}`)
      } else if (r.signers.includes(expected.auth)) {
        console.log(`   ok    ${label}`)
        console.log(`         requires a signature from ${expected.auth}`)
      } else {
        findings++
        console.log(`   *** FINDING  ${label}`)
        console.log(
          `         demanded no signature from the admin — required: ` +
            `${r.signers.length ? r.signers.join(', ') : 'nobody'}`,
        )
      }
      continue
    }

    // "It must refuse, with this error, raised by this contract."
    if (!r.refused) {
      findings++
      console.log(`   *** FINDING  ${label}`)
      console.log(`         it did NOT refuse — returned ${JSON.stringify(r.value)}`)
      continue
    }
    const named = r.fromVault && r.code ? ERRORS[r.code] ?? `#${r.code}` : null
    if (named === expected) {
      console.log(`   ok    ${label}`)
      console.log(`         refused: ${named}`)
    } else {
      findings++
      console.log(`   *** WRONG REASON  ${label}`)
      console.log(`         expected ${expected}, got ${describe(r)}`)
    }
  }
  return findings
}

/** What a refusal was, being careful about whose error code it is. */
function describe(r) {
  if (r.fromVault && r.code) return ERRORS[r.code] ?? `vault error #${r.code}`
  if (r.code) return `error #${r.code} from another contract — ${r.raw.split('\n')[0]}`
  return r.raw.split('\n')[0]
}

// What this harness does not reach. Listed rather than omitted: a pass that
// prints "all clear" over a class it never ran is the failure mode a harness
// has.
const GAPS = [
  '§1  premium above the quote — needs a co-signature from /api/vault/authorize',
  '§2  escrow mismatch — needs a funded writer and a real open',
  '§3  solvency break — read continuously by scripts/reproduce/read.mjs instead',
  '§4  limit EVASION — the caps validate themselves above, but exceeding one at',
  '    open needs collateral in the size it is set at (see the test-capital note)',
  '§5  quoter signature abuse — needs the authorize endpoint and a built auth tree',
  '§7  outcome inversion — needs a position straddling the strike at its own expiry',
  '§9  settlement denial — needs a position aged past the oracle window',
  '§12 §13 §15 §16 — HTTP surfaces, not contract calls; covered by the route tests',
  '§17 malicious quoter — needs the quoter key; the ceiling it hits is checked above',
  '§18 routing — Horizon path payments, not vault calls; covered by the routing tests',
  '§19 unavailable dependency — needs an outage to stand in; unit tests cover feeds',
  '    down, every spot source down and limits unreadable, not every dependency',
]

async function main() {
  const only = (process.argv[2] ?? '').toUpperCase()
  const books = only ? [only] : Object.keys(VAULTS)
  if (only && !VAULTS[only]) {
    console.error(`usage: node scripts/adversarial/refuse.mjs [${Object.keys(VAULTS).join('|')}]`)
    process.exit(1)
  }

  console.log('Simulated attacks on the deployed books. Nothing is submitted.')
  let findings = 0
  for (const b of books) findings += await run(b)

  console.log('\n── not covered here')
  for (const g of GAPS) console.log(`   ${g}`)

  console.log(
    findings === 0
      ? '\nEvery attempt refused, for the reason it should have.\n'
      : `\n${findings} attempt(s) did not refuse as expected — see above.\n`,
  )
  process.exit(findings === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
