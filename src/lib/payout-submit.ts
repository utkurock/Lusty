// Submitting a distributor payout, and knowing what a failure means.
// =================================================================
// The swap and the bridge both pay out against a payment the caller already
// made, behind a replay guard keyed on that payment's hash. Both used to
// release the guard on ANY submit error, so the caller could retry.
//
// That is right only when the network has said no. Horizon answers a
// submission it could not confirm in time with a 504, and a connection that
// drops mid-request answers with nothing at all; in both cases the signed
// payout may already be in a ledger, or may still land before its time bound.
// Releasing the guard then lets the same funding hash be paid a second time,
// out of the same float, by a retry that sees nothing wrong.
//
// So a failure is split in two. A 400 carrying result codes is the network's
// final word: the transaction was refused or failed, nothing moved, and the
// guard can go. Anything else is unknown, and the guard stays where it is with
// the payout's hash written beside it, so the one transaction that may have
// paid can be looked up rather than paid again.

export type PayoutSubmission =
  | { kind: 'landed'; hash: string }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'unknown'; hash: string; error: unknown }

/**
 * True only when Horizon reported a final result for the transaction and that
 * result was not success. Every other failure, including a timeout, a 5xx and
 * no response at all, leaves the outcome open.
 */
export function rejectedByNetwork(err: any): boolean {
  const res = err?.response
  return res?.status === 400 && !!res?.data?.extras?.result_codes?.transaction
}

export async function submitPayout(
  submit: () => Promise<{ hash: string }>,
  payoutHash: string,
): Promise<PayoutSubmission> {
  try {
    const res = await submit()
    return { kind: 'landed', hash: res.hash }
  } catch (error) {
    if (rejectedByNetwork(error)) return { kind: 'rejected', error }
    return { kind: 'unknown', hash: payoutHash, error }
  }
}
