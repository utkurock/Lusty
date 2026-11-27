import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Horizon } from '@stellar/stellar-sdk'
import {
  compareRelease,
  describeDrift,
  networkReaders,
  observeRelease,
  type Drift,
  type Manifest,
  type Readers,
} from '@/lib/drift.mjs'
import { HORIZON_URL, NETWORK, NETWORK_PASSPHRASE, RPC_URL } from '@/lib/stellar'
import type { Alert } from './notify'

/**
 * The release manifest, checked on the monitor's timer.
 *
 * `scripts/check-drift.mjs` compares what the network runs against
 * `release/<network>.json`, but only when somebody runs it. Most of what it
 * catches arrives without anyone deciding to look: a signer added to the
 * treasury, an admin threshold lowered, a quoter added from a key that was
 * never in a commit. Each is one transaction from a role account, and none of
 * them passes through this application.
 *
 * So the monitor runs the same comparison — the same module, the same readers —
 * and every difference is critical. The manifest is the reviewed release; a
 * network that has moved away from it is running something nobody reviewed,
 * and the only two answers are to put the network back or to commit the change
 * to the manifest. A manifest that is missing, unreadable or for another
 * network is critical too: it means the check is not checking anything.
 */

const manifestPath = () => join(process.cwd(), 'release', `${NETWORK.name}.json`)

/** The deployment's release manifest, `release/<network>.json`. */
export async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(manifestPath(), 'utf8'))
}

function liveReaders(): Readers {
  const horizon = new Horizon.Server(HORIZON_URL)
  return networkReaders({
    rpcUrl: RPC_URL,
    passphrase: NETWORK_PASSPHRASE,
    loadHorizonAccount: (address: string) => horizon.loadAccount(address),
  })
}

/** The alert for a comparison's result, or null when there is no drift. Pure. */
export function releaseDriftAlert(drift: Drift[], manifest: Manifest): Alert | null {
  if (drift.length === 0) return null
  const lines = drift.map(describeDrift)
  return {
    severity: 'critical',
    title: 'Network has drifted from the release manifest',
    message:
      `${drift.length} difference(s) between ${manifest.network} and release/${manifest.network}.json: ` +
      `${lines.join('; ')}. The manifest is the reviewed release. Either the network changed ` +
      'without a commit — put it back, or find out who changed it — or the change was meant, ' +
      'and the manifest has to be updated in a commit that says so.',
    fields: [
      { label: 'differences', value: String(drift.length) },
      { label: 'books', value: Object.keys(manifest.books).join(', ') },
      ...drift.slice(0, 10).map((d) => ({ label: d.path, value: describeDrift(d).slice(0, 200) })),
    ],
  }
}

type Deps = { loadManifest?: () => Promise<Manifest>; readers?: () => Readers }

/** One book as the network runs it. */
export interface ReleaseBook {
  symbol: string
  vault: string
  /** The wasm hash the instance runs, hex. */
  wasmHash: string
}

/**
 * The release as the network runs it against its manifest, read once. The
 * monitor turns it into an alert and /api/health reports it; both read it here
 * so the two cannot disagree about what "no drift" means.
 */
export type ReleaseState =
  | {
      status: 'ok' | 'drift'
      network: string
      /** The manifest's reviewed hash. */
      reviewedWasmHash: string
      books: ReleaseBook[]
      drift: Drift[]
      manifest: Manifest
    }
  | { status: 'no-manifest' | 'wrong-network' | 'unreadable'; network: string; error: string }

/**
 * Each book's hash out of an observed release. `observeRelease` carries one
 * hash at the top when every book agrees and a JSON map by symbol when not.
 */
function bookHashes(observed: Manifest): Record<string, string> {
  if (/^[0-9a-f]{64}$/.test(observed.wasmHash)) {
    return Object.fromEntries(Object.keys(observed.books).map((s) => [s, observed.wasmHash]))
  }
  return JSON.parse(observed.wasmHash)
}

export async function readReleaseState(deps: Deps = {}): Promise<ReleaseState> {
  const network = NETWORK.name
  let manifest: Manifest
  try {
    manifest = await (deps.loadManifest ?? readManifest)()
  } catch (e: any) {
    return { status: 'no-manifest', network, error: e?.message ?? 'unknown' }
  }
  if (manifest.network !== network) {
    return { status: 'wrong-network', network, error: `the manifest describes ${manifest.network}` }
  }
  try {
    const observed = await observeRelease(manifest, (deps.readers ?? liveReaders)())
    const drift = compareRelease(manifest, observed)
    const hashes = bookHashes(observed)
    return {
      status: drift.length === 0 ? 'ok' : 'drift',
      network,
      reviewedWasmHash: manifest.wasmHash,
      books: Object.entries(observed.books).map(([symbol, b]) => ({
        symbol,
        vault: b.vault,
        wasmHash: hashes[symbol],
      })),
      drift,
      manifest,
    }
  } catch (e: any) {
    return { status: 'unreadable', network, error: e?.message ?? 'unknown' }
  }
}

export async function checkReleaseDrift(deps: Deps = {}): Promise<Alert | null> {
  const state = await readReleaseState(deps)
  switch (state.status) {
    case 'ok':
    case 'drift':
      return releaseDriftAlert(state.drift, state.manifest)
    case 'no-manifest':
      return {
        severity: 'critical',
        title: 'No release manifest to check the network against',
        message: `Could not read release/${state.network}.json: ${state.error}. Without it a changed signer, threshold, quoter or wasm on ${state.network} goes unreported.`,
      }
    case 'wrong-network':
      return {
        severity: 'critical',
        title: 'Release manifest is for another network',
        message: `release/${state.network}.json is not for ${state.network}: ${state.error}. Nothing it records can be compared.`,
      }
    case 'unreadable':
      return {
        severity: 'critical',
        title: 'Release drift check failed',
        message: `Could not read ${state.network} to compare it with its release manifest: ${state.error}. A role account or instance changed since the last good read would go unreported.`,
      }
  }
}
