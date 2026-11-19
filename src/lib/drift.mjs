// The release manifest, and what the chain actually runs against it.
//
// `release/<network>.json` is the record of a release: the one wasm hash every
// book runs, each instance's config, limits and quoter set exactly as the
// contract returns them, and every account those name (admin, treasury,
// guardian, each quoter) with its signers and thresholds. It is reviewed like
// code and changed only by a commit.
//
// Drift is any difference between that record and the network. The limits
// reconciliation in lib/vault-limits covers one field of one instance on the
// money path; this covers the whole release, including what no contract
// call returns: an admin multisig whose threshold was lowered, a signer added
// to the treasury, an instance upgraded to a wasm nobody reviewed.
//
// Plain JavaScript for the same reason as lib/network.mjs: the operator script
// (scripts/check-drift.mjs) runs it under Node without a build step, and the
// tests import it like any other module. The network is reached only through
// the readers passed in, so the comparison runs against fakes as easily as
// against the RPC and Horizon.

import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

/**
 * @typedef {object} Signer
 * @property {string} key
 * @property {number} weight
 */

/**
 * @typedef {object} RoleAccount
 * @property {string[]} roles what the release uses it for, e.g. ["admin"]
 * @property {{ low: number, med: number, high: number }} thresholds
 * @property {Signer[]} signers
 */

/**
 * @typedef {object} Book
 * @property {string} vault the instance's contract id
 * @property {Record<string, unknown>} config `config()` as the contract returns it
 * @property {Record<string, unknown>} limits `limits()` in the contract's own units
 * @property {string[]} quoters
 */

/**
 * @typedef {object} Manifest
 * @property {string} network
 * @property {string} wasmHash hex sha-256 of the reviewed build every book runs
 * @property {Record<string, Book>} books keyed by underlying symbol
 * @property {Record<string, RoleAccount>} accounts keyed by address
 */

/**
 * @typedef {object} Drift
 * @property {string} path where in the manifest, e.g. "books.XLM.limits.max_premium_bps"
 * @property {unknown} expected undefined when the manifest has nothing there
 * @property {unknown} observed undefined when the network has nothing there
 */

/**
 * @typedef {object} Readers
 * @property {(contractId: string, method: string) => Promise<unknown>} readContract
 * @property {(contractId: string) => Promise<string>} readWasmHash hex
 * @property {(address: string) => Promise<{ thresholds: RoleAccount['thresholds'], signers: Signer[] }>} loadAccount
 */

/**
 * Contract values as JSON: i128/u64 become decimal strings, so a stroop is
 * never rounded away by a float, and sets are sorted so order is not drift.
 * @param {unknown} v
 * @returns {unknown}
 */
export function normalize(v) {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, normalize(x)]),
    )
  }
  return v
}

const bySigner = (/** @type {Signer} */ a, /** @type {Signer} */ b) => a.key.localeCompare(b.key)

/** Every address a book names that holds a role, with the role. */
export function roleAccounts(/** @type {Book} */ book) {
  /** @type {Array<[string, string]>} */
  const out = []
  const c = /** @type {Record<string, string | null | undefined>} */ (book.config)
  for (const role of ['admin', 'treasury', 'guardian']) {
    if (c[role]) out.push([/** @type {string} */ (c[role]), role])
  }
  for (const q of book.quoters) out.push([q, 'quoter'])
  return out
}

/**
 * Read everything the manifest describes off the network, in the manifest's
 * own shape, so the comparison is one structural diff. The books read are
 * the manifest's; every account either side names is read.
 *
 * @param {Manifest} manifest
 * @param {Readers} readers
 * @returns {Promise<Manifest>}
 */
export async function observeRelease(manifest, readers) {
  /** @type {Record<string, Book>} */
  const books = {}
  /** @type {Record<string, string>} */
  const wasm = {}
  for (const [symbol, book] of Object.entries(manifest.books)) {
    const [hash, config, limits, quoters] = await Promise.all([
      readers.readWasmHash(book.vault),
      readers.readContract(book.vault, 'config'),
      readers.readContract(book.vault, 'limits'),
      readers.readContract(book.vault, 'quoters'),
    ])
    wasm[symbol] = hash
    books[symbol] = {
      vault: book.vault,
      config: /** @type {Record<string, unknown>} */ (normalize(config)),
      limits: /** @type {Record<string, unknown>} */ (normalize(limits)),
      quoters: [.../** @type {string[]} */ (quoters)].sort(),
    }
  }

  // The accounts to read: those the manifest lists and those the chain names,
  // so a quoter added on chain is read (and reported) rather than skipped.
  const addresses = new Set(Object.keys(manifest.accounts))
  for (const book of Object.values(books)) {
    for (const [address] of roleAccounts(book)) addresses.add(address)
  }

  /** @type {Record<string, RoleAccount>} */
  const accounts = {}
  for (const address of [...addresses].sort()) {
    /** @type {Set<string>} */
    const roles = new Set()
    for (const book of Object.values(books)) {
      for (const [a, role] of roleAccounts(book)) if (a === address) roles.add(role)
    }
    try {
      const acc = await readers.loadAccount(address)
      accounts[address] = {
        roles: [...roles].sort(),
        thresholds: acc.thresholds,
        signers: [...acc.signers].sort(bySigner),
      }
    } catch (e) {
      // An account that cannot be loaded is reported as missing. That is
      // drift whether it was merged away or never created.
      if (/** @type {any} */ (e)?.response?.status !== 404) throw e
    }
  }

  // Each book's hash is compared against the one the release names, so it is
  // carried at the top when they all agree and per book when they do not.
  const hashes = new Set(Object.values(wasm))
  const wasmHash = hashes.size === 1 ? [...hashes][0] : JSON.stringify(wasm)

  return { network: manifest.network, wasmHash, books, accounts }
}

/**
 * The manifest in the shape `observeRelease` returns, with sets sorted.
 * @param {Manifest} m
 * @returns {Manifest}
 */
function canonical(m) {
  return {
    network: m.network,
    wasmHash: m.wasmHash,
    books: Object.fromEntries(
      Object.entries(m.books).map(([s, b]) => [
        s,
        { vault: b.vault, config: b.config, limits: b.limits, quoters: [...b.quoters].sort() },
      ]),
    ),
    accounts: Object.fromEntries(
      Object.entries(m.accounts).map(([a, r]) => [
        a,
        { roles: [...r.roles].sort(), thresholds: r.thresholds, signers: [...r.signers].sort(bySigner) },
      ]),
    ),
  }
}

/**
 * Every place the network departs from the manifest. Pure.
 *
 * @param {Manifest} manifest
 * @param {Manifest} observed
 * @returns {Drift[]}
 */
export function compareRelease(manifest, observed) {
  /** @type {Drift[]} */
  const out = []
  diff(canonical(manifest), observed, '', out)
  return out
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} path
 * @param {Drift[]} out
 */
function diff(a, b, path, out) {
  const isObj = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (isObj(a) && isObj(b)) {
    const ao = /** @type {Record<string, unknown>} */ (a)
    const bo = /** @type {Record<string, unknown>} */ (b)
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      diff(ao[k], bo[k], path ? `${path}.${k}` : k, out)
    }
    return
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path, expected: a, observed: b })
  }
}

/** One line per drift, for a terminal or an alert. */
export function describeDrift(/** @type {Drift} */ d) {
  const show = (/** @type {unknown} */ v) => (v === undefined ? '(absent)' : JSON.stringify(v))
  return `${d.path}: manifest ${show(d.expected)}, network ${show(d.observed)}`
}

/**
 * Readers backed by a Soroban RPC and a Horizon server.
 *
 * @param {{ rpcUrl: string, passphrase: string, loadHorizonAccount: (address: string) => Promise<any> }} opts
 * @returns {Readers}
 */
export function networkReaders({ rpcUrl, passphrase, loadHorizonAccount }) {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') })
  // Simulation needs a well-formed source account, not a funded one.
  const probe = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
  return {
    async readContract(contractId, method) {
      const tx = new TransactionBuilder(new Account(probe, '0'), {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(new Contract(contractId).call(method))
        .setTimeout(30)
        .build()
      const sim = await server.simulateTransaction(tx)
      if (rpc.Api.isSimulationError(sim)) throw new Error(`${contractId}.${method}: ${sim.error}`)
      if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        throw new Error(`${contractId}.${method} returned nothing`)
      }
      return scValToNative(sim.result.retval)
    },
    async readWasmHash(contractId) {
      const entry = await server.getContractData(
        contractId,
        xdr.ScVal.scvLedgerKeyContractInstance(),
        rpc.Durability.Persistent,
      )
      return entry.val.contractData().val().instance().executable().wasmHash().toString('hex')
    },
    async loadAccount(address) {
      const acc = await loadHorizonAccount(address)
      return {
        thresholds: {
          low: acc.thresholds.low_threshold,
          med: acc.thresholds.med_threshold,
          high: acc.thresholds.high_threshold,
        },
        signers: acc.signers.map((/** @type {any} */ s) => ({ key: s.key, weight: s.weight })),
      }
    },
  }
}
