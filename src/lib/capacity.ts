/**
 * The share of one side's capacity in use, read off a `/api/vault/stats`
 * response; null when the figures are not there to read.
 *
 * The call side is `call.utilized` / `call.cap`, in the book's own unit. It was
 * `call.utilizedXlm` / `call.capXlm` until M2-06 renamed them, and reading the
 * old names turned every book's call bar into a dash.
 */
export function capacityUsedPct(d: any, side: 'call' | 'put'): number | null {
  if (!d?.ok) return null
  const used = Number(side === 'call' ? d.call?.utilized : d.put?.utilizedUsd)
  const cap = Number(side === 'call' ? d.call?.cap : d.put?.capUsd)
  if (!isFinite(used) || !isFinite(cap) || cap <= 0) return null
  return (used / cap) * 100
}
