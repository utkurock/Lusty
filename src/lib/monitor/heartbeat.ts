/**
 * Pings to an external dead-man's switch.
 *
 * Every alert in this directory is raised by the monitor, and the runner check
 * reads a log the runner writes. Neither can report its own absence: a server
 * that is down sends no alert saying so, and a monitor that stopped looks, from
 * the alert channel, exactly like a quiet day.
 *
 * So each run that completes pings a URL held by a service outside this
 * deployment (healthchecks.io, Better Stack, Cronitor — anything that alerts
 * when an expected ping does not arrive). The service, not this code, decides
 * when silence is an outage, and it is configured there with each job's
 * interval and grace.
 *
 * A ping says the job did its work, not merely that it started:
 *
 *   • the monitor pings only when every alert it raised was delivered, so an
 *     alert channel that has stopped working is caught as well;
 *   • the settlement sweep pings only for a run that ended `ok` — a run that
 *     threw, or that could only scan because it has no key, is not a runner
 *     settling anything.
 *
 * Unset URL = no ping, the way an unset alert channel is skipped. A ping that
 * fails is logged and never fails the run it reports on.
 */

export type HeartbeatJob = 'monitor' | 'settle'

const ENV: Record<HeartbeatJob, string> = {
  monitor: 'MONITOR_HEARTBEAT_URL',
  settle: 'SETTLE_HEARTBEAT_URL',
}

const TIMEOUT_MS = 5_000

export type HeartbeatResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string }

export async function pingHeartbeat(job: HeartbeatJob): Promise<HeartbeatResult> {
  const url = process.env[ENV[job]] ?? ''
  if (!url) return { status: 'skipped', reason: `${ENV[job]} not set` }
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      console.warn(`heartbeat: ${job} ping answered ${res.status}`)
      return { status: 'error', reason: `HTTP ${res.status}` }
    }
    return { status: 'sent' }
  } catch (e: any) {
    console.warn(`heartbeat: ${job} ping failed`, e?.message ?? e)
    return { status: 'error', reason: e?.message ?? 'unknown' }
  }
}
