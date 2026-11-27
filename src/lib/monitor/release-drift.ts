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

export async function checkReleaseDrift(
  deps: { loadManifest?: () => Promise<Manifest>; readers?: () => Readers } = {},
): Promise<Alert | null> {
  let manifest: Manifest
  try {
    manifest = await (deps.loadManifest ?? readManifest)()
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'No release manifest to check the network against',
      message: `Could not read release/${NETWORK.name}.json: ${e?.message ?? 'unknown'}. Without it a changed signer, threshold, quoter or wasm on ${NETWORK.name} goes unreported.`,
    }
  }
  if (manifest.network !== NETWORK.name) {
    return {
      severity: 'critical',
      title: 'Release manifest is for another network',
      message: `release/${NETWORK.name}.json describes ${manifest.network}; this deployment runs ${NETWORK.name}. Nothing it records can be compared.`,
    }
  }
  try {
    const observed = await observeRelease(manifest, (deps.readers ?? liveReaders)())
    return releaseDriftAlert(compareRelease(manifest, observed), manifest)
  } catch (e: any) {
    return {
      severity: 'critical',
      title: 'Release drift check failed',
      message: `Could not read ${NETWORK.name} to compare it with its release manifest: ${e?.message ?? 'unknown'}. A role account or instance changed since the last good read would go unreported.`,
    }
  }
}
