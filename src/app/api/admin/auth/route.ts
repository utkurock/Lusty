import { NextResponse } from 'next/server'
import {
  Keypair,
  TransactionBuilder,
  Operation,
  Networks,
  BASE_FEE,
  Account,
} from '@stellar/stellar-sdk'
import { isAdmin } from '@/lib/db-queries'
import { isValidStellarAddress } from '@/lib/utils'
import { createChallenge, consumeChallenge, createSession } from '@/lib/admin-sessions'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/auth
 * Step 1: { action: 'challenge', address: 'G...' }
 *   → Returns { challengeId, xdr } for the wallet to sign
 *
 * Step 2: { action: 'verify', challengeId, signedXdr }
 *   → Verifies signature, returns { token } session token
 */
export async function POST(req: Request) {
  try {
    const body = await req.json()

    if (body.action === 'challenge') {
      const { address } = body
      if (!isValidStellarAddress(address)) {
        return NextResponse.json({ error: 'invalid address' }, { status: 400 })
      }

      const admin = await isAdmin(address)
      if (!admin) {
        return NextResponse.json({ error: 'not authorized' }, { status: 403 })
      }

      const { challengeId, nonce } = createChallenge(address)

      // Build a dummy ManageData tx for the wallet to sign
      // Using sequence "0" — this tx is never submitted, just signed to prove ownership
      const account = new Account(address, '0')
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.manageData({ name: 'lusty_admin_auth', value: nonce })
        )
        .setTimeout(120)
        .build()

      return NextResponse.json({
        ok: true,
        challengeId,
        xdr: tx.toXDR(),
      })
    }

    if (body.action === 'verify') {
      const { challengeId, signedXdr } = body
      if (!challengeId || !signedXdr) {
        return NextResponse.json({ error: 'missing fields' }, { status: 400 })
      }

      const challenge = consumeChallenge(challengeId)
      if (!challenge) {
        return NextResponse.json({ error: 'challenge expired or invalid' }, { status: 401 })
      }

      // Parse the signed transaction and verify signature
      const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET)
      const keypair = Keypair.fromPublicKey(challenge.address)

      // Verify at least one signature matches the admin's public key
      const txHash = tx.hash()
      const validSig = tx.signatures.some((sig) => {
        try {
          return keypair.verify(txHash, sig.signature())
        } catch {
          return false
        }
      })

      if (!validSig) {
        return NextResponse.json({ error: 'invalid signature' }, { status: 403 })
      }

      // Verify the ManageData operation contains our nonce
      const ops = (tx as any).operations ?? []
      const authOp = ops.find(
        (op: any) => op.type === 'manageData' && op.name === 'lusty_admin_auth'
      )
      if (!authOp || authOp.value?.toString() !== challenge.nonce) {
        return NextResponse.json({ error: 'nonce mismatch' }, { status: 403 })
      }

      const token = createSession(challenge.address)
      return NextResponse.json({ ok: true, token })
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'auth failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
