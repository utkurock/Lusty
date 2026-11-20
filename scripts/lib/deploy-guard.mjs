// What a public-network deploy has to satisfy before it signs anything.
//
// The release manifest (release/<network>.json) is the reviewed record: one
// wasm hash, each book's config and limits, every role account's signers and
// thresholds. On testnet a deploy copies the desk off a reference instance,
// which is fine — nothing there was reviewed. On the public network the
// manifest is the authority, and every refusal below is a way the deploy could
// have put something other than the reviewed release on chain.
//
// Pure: it is handed what the deploy would construct with and what Horizon
// says about each role account, and returns the reasons to stop. No network,
// no filesystem, so the tests run it without either.

/**
 * The control each role account must be under, from docs/SECURITY.md and the
 * mainnet role table. The guardian's med threshold is 1 on purpose: any single
 * signer pauses, but two are needed to change the account.
 */
export const ROLE_CONTROLS = {
  admin: { minSigners: 3, minMed: 2, minHigh: 2 },
  treasury: { minSigners: 3, minMed: 2, minHigh: 2 },
  guardian: { minSigners: 3, minMed: 1, minHigh: 2 },
}

/** The config fields a book's instance is constructed with. */
const CONFIG_FIELDS = ['oracle', 'feed', 'token', 'cash', 'treasury', 'admin', 'guardian']

/** Every limit a v6 instance enforces, in the contract's own field names. */
const LIMIT_FIELDS = [
  'max_position_call',
  'max_position_put',
  'max_expiry_call',
  'max_expiry_put',
  'max_open_call',
  'max_open_put',
  'max_premium_bps',
]

const sortSigners = (signers) =>
  [...(signers ?? [])].sort((a, b) => a.key.localeCompare(b.key))

/** An account's signers and thresholds as the manifest records them. */
const accountShape = (acc) =>
  JSON.stringify({
    thresholds: {
      low: acc.thresholds?.low,
      med: acc.thresholds?.med,
      high: acc.thresholds?.high,
    },
    signers: sortSigners(acc.signers).map((s) => ({ key: s.key, weight: s.weight })),
  })

/**
 * The desk a book is deployed with, read out of the manifest rather than off a
 * reference instance. Null when the manifest does not declare the book.
 *
 * @param {object} manifest
 * @param {string} symbol
 */
export function deskFromManifest(manifest, symbol) {
  const book = manifest?.books?.[symbol]
  if (!book) return null
  const c = book.config ?? {}
  return {
    oracle: c.oracle,
    feed: c.feed,
    token: c.token,
    cash: c.cash,
    treasury: c.treasury,
    admin: c.admin,
    guardian: c.guardian,
    quoters: [...(book.quoters ?? [])],
    limits: { ...(book.limits ?? {}) },
  }
}

/**
 * Every reason not to deploy. Empty means the deploy puts exactly the reviewed
 * release on chain.
 *
 * @param {object} opts
 * @param {object} opts.manifest release/<network>.json, parsed
 * @param {string} opts.network the network the scripts resolved
 * @param {string} opts.symbol the book being deployed
 * @param {string | null} opts.wasmHash hex hash of the wasm about to be deployed
 * @param {object} opts.desk what the constructor would be called with
 * @param {Record<string, unknown>} opts.limits the limits it would be called with, as decimal strings
 * @param {Record<string, { thresholds: object, signers: object[] } | null>} opts.accounts
 *        Horizon's reading of each role account, null when it could not be loaded
 * @returns {string[]}
 */
export function releaseRefusals({ manifest, network, symbol, wasmHash, desk, limits, accounts }) {
  const out = []
  if (!manifest || typeof manifest !== 'object') {
    return [`no release manifest for the ${network} network; the reviewed release has to be recorded before it can be deployed`]
  }
  if (manifest.network !== network) {
    out.push(`the manifest is for ${manifest.network}, not ${network}`)
  }

  const book = deskFromManifest(manifest, symbol)
  if (!book) {
    out.push(`the manifest declares no ${symbol} book, so there is nothing reviewed to deploy`)
    return out
  }

  // The hash is the whole point of the review: a build nobody reviewed is not
  // the release whatever else matches.
  if (!wasmHash) {
    out.push(`--wasm is required on ${network}: the hash deployed has to be the manifest's ${manifest.wasmHash}`)
  } else if (wasmHash !== manifest.wasmHash) {
    out.push(`the wasm hashes ${wasmHash}, not the manifest's reviewed ${manifest.wasmHash}`)
  }

  for (const field of CONFIG_FIELDS) {
    const want = book[field]
    const got = desk?.[field] ?? null
    if (!want) {
      out.push(`the manifest's ${symbol} book names no ${field}`)
      continue
    }
    if (got !== want) out.push(`${field} would be ${got ?? '(unset)'}, the manifest's is ${want}`)
  }

  for (const field of LIMIT_FIELDS) {
    const want = book.limits[field]
    const got = limits?.[field]
    if (want === undefined) {
      out.push(`the manifest's ${symbol} limits name no ${field}`)
      continue
    }
    if (String(got) !== String(want)) {
      out.push(`${field} would be ${got ?? '(unset)'}, the manifest's is ${want}`)
    }
  }

  const quoters = [...(desk?.quoters ?? [])].sort()
  if (JSON.stringify(quoters) !== JSON.stringify([...book.quoters].sort())) {
    out.push(`the quoter set would be ${quoters.join(', ') || '(empty)'}, the manifest's is ${book.quoters.join(', ')}`)
  }

  // Each role account twice over: it has to be what the manifest recorded, and
  // what it recorded has to be multisig. A manifest that recorded a single-key
  // admin would otherwise pass its own comparison.
  for (const [role, control] of Object.entries(ROLE_CONTROLS)) {
    const address = book[role]
    if (!address) continue
    const recorded = manifest.accounts?.[address]
    const live = accounts?.[address] ?? null
    if (!recorded) {
      out.push(`the manifest has no record of the ${role} account ${address}`)
      continue
    }
    if (!live) {
      out.push(`the ${role} account ${address} could not be read from Horizon`)
      continue
    }
    if (accountShape(recorded) !== accountShape(live)) {
      out.push(`the ${role} account ${address} does not match the manifest's record of its signers and thresholds`)
    }
    const signers = sortSigners(live.signers)
    const t = live.thresholds ?? {}
    if (signers.length < control.minSigners) {
      out.push(`the ${role} account ${address} has ${signers.length} signer(s), and the release documents ${control.minSigners}`)
    }
    if (Number(t.med) < control.minMed) {
      out.push(`the ${role} account ${address} has a med threshold of ${t.med}, below the documented ${control.minMed}`)
    }
    if (Number(t.high) < control.minHigh) {
      out.push(`the ${role} account ${address} has a high threshold of ${t.high}, below the documented ${control.minHigh}`)
    }
  }

  return out
}
