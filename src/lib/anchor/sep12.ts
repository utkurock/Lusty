/**
 * SEP-12: KYC, which this anchor simulates.
 *
 * It asks for nothing and stores nothing — a PUT with no fields is accepted —
 * so there is no form here, only the status and a button that clears it. The
 * shape is real even though the check is not: a production anchor answers the
 * same two calls with real fields, and this is where that form would go.
 */

import { anchorFetch, loadAnchorToml, query, AnchorError } from './client'

export interface CustomerStatus {
  status: 'NEEDS_INFO' | 'ACCEPTED' | 'PROCESSING' | 'REJECTED' | string
  message?: string
  fields?: Record<string, { description?: string; optional?: boolean }>
}

async function kycServer(): Promise<string> {
  const toml = await loadAnchorToml()
  if (!toml.kycServer) throw new AnchorError('this anchor publishes no KYC server', 0, 'stellar.toml')
  return toml.kycServer
}

export async function fetchCustomer(account: string, token: string): Promise<CustomerStatus> {
  return anchorFetch<CustomerStatus>(`${await kycServer()}/customer${query({ account })}`, { token })
}

/** Accept the simulated KYC. No personal data is sent, because none is asked for. */
export async function acceptCustomer(account: string, token: string): Promise<void> {
  await anchorFetch(`${await kycServer()}/customer`, {
    token,
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account }),
  })
}
