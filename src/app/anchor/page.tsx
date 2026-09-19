'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Building2, ExternalLink, Wallet } from 'lucide-react'
import { AssetList, type Tab } from '@/components/earn/AssetList'
import { RoundTripDiagram } from '@/components/anchor/RoundTripDiagram'
import { PayoffSketch } from '@/components/anchor/PayoffSketch'
import { LUSD_CODE } from '@/lib/lusd'
import { useAnchorConfig } from '@/lib/anchor/useAnchor'
import { fetchHeadlineRate } from '@/lib/anchor/sep38'
import { EXPLORER_ACCOUNT } from '@/lib/anchor/chain'
import { ANCHOR_ASSET_CODE, ANCHOR_HOME_DOMAIN, FIAT_CODE } from '@/lib/anchor/config'

const ON_RAMP = [
  'You sign in with your Stellar key.',
  'The anchor answers with an IBAN and a reference to write in the transfer description.',
  'The lira arrives and is credited. In this sandbox you play the bank.',
  `Real testnet ${ANCHOR_ASSET_CODE} is paid to your wallet at the rate you were quoted.`,
]

const OFF_RAMP = [
  'You start a withdrawal and get the treasury address plus a memo.',
  `Your wallet sends ${ANCHOR_ASSET_CODE} on Stellar testnet with that memo attached.`,
  'The anchor notices the payment and sells at the locked rate.',
  'Lira is paid to the IBAN on file, over simulated FAST.',
]

export default function AnchorOverviewPage() {
  const { toml, currency, loading, error } = useAnchorConfig()
  const [rate, setRate] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('puts')

  useEffect(() => {
    fetchHeadlineRate()
      .then(r => setRate(r?.price ?? null))
      .catch(() => setRate(null))
  }, [])

  const treasury = toml?.accounts?.[0]

  return (
    <>
      <section className="terminal-card p-10 md:p-14 relative overflow-hidden bg-inverse shadow-table animate-rise">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'url(/hero-dither.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: 0.35,
            mixBlendMode: 'screen',
          }}
        />
        <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-inverse via-inverse/70 to-transparent" />
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 relative">
          <div className="max-w-2xl">
            <div className="font-mono text-caption text-brand mb-3">~/anchor</div>
            <h1 className="font-display text-hero md:text-hero-lg text-cream">
              Lira in.<br />Dollars out.
            </h1>
            <p className="mt-5 font-mono text-body text-cream/70 max-w-md">
              A Turkish {FIAT_CODE} ⇄ {ANCHOR_ASSET_CODE} ramp, spoken in the standard Stellar
              dialect. The bank is simulated. The Stellar leg is real testnet money.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/anchor/deposit" className="btn btn-primary press">
                start with lira <ArrowRight size={16} />
              </Link>
              <Link
                href="/anchor/convert"
                className="btn press border border-cream/25 text-cream hover:bg-cream/10"
              >
                i already hold {ANCHOR_ASSET_CODE}
              </Link>
            </div>
          </div>

          <div className="text-right">
            <div className="label text-cream/50">
              {ANCHOR_ASSET_CODE} / {FIAT_CODE}
            </div>
            <div className="num text-head-lg font-bold text-cream mt-1">
              {rate ? Number(rate).toFixed(4) : '—'}
            </div>
            <div className="font-mono text-caption text-cream/50 mt-1">
              buy rate · 50 bps over mid
            </div>
          </div>
        </div>
      </section>

      {error && <div className="notice notice-error">{error}</div>}

      <section className="light-card p-6 animate-rise">
        <h2 className="label">one path, five stops</h2>
        <p className="font-mono text-caption text-ink-2 mt-2 mb-5 max-w-2xl">
          Each tab above is one leg of this. Nothing here is automatic: every stop is something
          you do, with your own key, and you can get off at any of them.
        </p>
        <RoundTripDiagram />
      </section>

      <section className="grid md:grid-cols-2 gap-6">
        <div className="light-card p-6 flex flex-col">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-brand" />
            <h2 className="font-display text-head-sm text-ink">
              On-ramp · {FIAT_CODE} → {ANCHOR_ASSET_CODE}
            </h2>
          </div>
          <ol className="mt-4 space-y-2 flex-1">
            {ON_RAMP.map((step, i) => (
              <li key={i} className="flex gap-3 font-mono text-caption text-ink-2">
                <span className="num text-brand shrink-0">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <Link href="/anchor/deposit" className="btn btn-primary press mt-5 self-start">
            start an on-ramp <ArrowRight size={16} />
          </Link>
        </div>

        <div className="light-card p-6 flex flex-col">
          <div className="flex items-center gap-2">
            <Wallet size={16} className="text-brand" />
            <h2 className="font-display text-head-sm text-ink">
              Off-ramp · {ANCHOR_ASSET_CODE} → {FIAT_CODE}
            </h2>
          </div>
          <ol className="mt-4 space-y-2 flex-1">
            {OFF_RAMP.map((step, i) => (
              <li key={i} className="flex gap-3 font-mono text-caption text-ink-2">
                <span className="num text-brand shrink-0">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <Link href="/anchor/withdraw" className="btn btn-ghost press mt-5 self-start">
            start an off-ramp <ArrowRight size={16} />
          </Link>
        </div>
      </section>

      <section className="light-card p-6">
        <div className="flex items-baseline justify-between flex-wrap gap-x-6 gap-y-1 mb-4">
          <h2 className="label">the market this ramp feeds</h2>
          <Link
            href="/earn"
            className="press rounded-sm font-mono text-caption text-brand inline-flex items-center gap-1"
          >
            open the market <ArrowRight size={12} />
          </Link>
        </div>
        {/* The venue's live books themselves, rows and all. The section used to
            mount a second copy of the market under its own route; there is one
            market, it runs off one pool, and a row here opens it where it
            lives. */}
        <AssetList tab={tab} onTabChange={setTab} />
      </section>

      <section className="grid md:grid-cols-2 gap-6">
        <div className="light-card p-6">
          <h2 className="label">what you are selling</h2>
          <div className="mt-4">
            <PayoffSketch />
          </div>
        </div>

        <div className="light-card p-6">
          <h2 className="label">from {ANCHOR_ASSET_CODE} to a written put</h2>

          <ol className="mt-4 space-y-3">
            {[
              {
                href: '/anchor/deposit',
                title: `on-ramp your lira`,
                body: `A bank transfer in ${FIAT_CODE} comes back as testnet ${ANCHOR_ASSET_CODE} in your own wallet, at a rate locked before you send.`,
                cta: 'start an on-ramp',
              },
              {
                href: '/anchor/convert',
                title: `cross to ${LUSD_CODE}`,
                body: `The vault escrows ${LUSD_CODE}, the venue's own testnet dollar, and neither it nor the anchor can mint the other. So the crossing is a payment each way: one for one, no spread, nothing to expire.`,
                cta: 'cross over',
              },
              {
                href: '/earn',
                title: 'write the put',
                body: `Pick an asset and a strike on the venue's own books. The ${LUSD_CODE} you just crossed is the collateral, the premium is paid the moment the position opens, and settlement is the same for everyone.`,
                cta: 'open the market',
              },
            ].map((step, i) => (
              <li key={step.href} className="flex gap-3">
                <span className="num text-brand shrink-0">{i + 1}</span>
                <div>
                  <div className="font-mono text-body text-ink">{step.title}</div>
                  <p className="font-mono text-caption text-ink-2 mt-1">{step.body}</p>
                  <Link
                    href={step.href}
                    className="press rounded-sm font-mono text-caption text-brand inline-flex items-center gap-1 mt-1.5"
                  >
                    {step.cta} <ArrowRight size={12} />
                  </Link>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-5 space-y-0">
            <Row label="crossing rate">1.0000000</Row>
            <Row label="spread">0 bps</Row>
            <Row label="premiums paid in">{LUSD_CODE}</Row>
            <Row label="settlement">unchanged</Row>
          </div>
        </div>
      </section>

      <section className="light-card p-6">
        <h2 className="label">what it is running on</h2>
        <div className="mt-3 space-y-0">
          <Row label="network">Stellar testnet</Row>
          <Row label="anchor">
            {loading ? '…' : toml?.orgName ?? ANCHOR_HOME_DOMAIN}
          </Row>
          <Row label="asset issuer">
            {currency ? (
              <a
                href={EXPLORER_ACCOUNT(currency.issuer)}
                target="_blank"
                rel="noopener noreferrer"
                className="press rounded-sm font-code text-caption text-brand break-all"
              >
                {currency.issuer}
              </a>
            ) : (
              '…'
            )}
          </Row>
          <Row label="treasury">
            {treasury ? (
              <a
                href={EXPLORER_ACCOUNT(treasury)}
                target="_blank"
                rel="noopener noreferrer"
                className="press rounded-sm font-code text-caption text-brand break-all"
              >
                {treasury}
              </a>
            ) : (
              '…'
            )}
          </Row>
        </div>
        <div className="flex flex-wrap gap-4 mt-4 font-mono text-caption">
          <a
            href={`https://${ANCHOR_HOME_DOMAIN}/.well-known/stellar.toml`}
            target="_blank"
            rel="noopener noreferrer"
            className="press rounded-sm text-ink-2 hover:text-ink inline-flex items-center gap-1"
          >
            stellar.toml <ExternalLink size={12} />
          </a>
          <a
            href={`https://${ANCHOR_HOME_DOMAIN}/sep`}
            target="_blank"
            rel="noopener noreferrer"
            className="press rounded-sm text-ink-2 hover:text-ink inline-flex items-center gap-1"
          >
            the anchor&apos;s own docs <ExternalLink size={12} />
          </a>
          <Link href="/earn" className="press rounded-sm text-ink-2 hover:text-ink inline-flex items-center gap-1">
            back to lusty <ArrowRight size={12} />
          </Link>
        </div>
      </section>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dashed-row flex items-baseline justify-between gap-4 py-2 last:border-0">
      <span className="label">{label}</span>
      <span className="num text-body text-ink text-right break-all">{children}</span>
    </div>
  )
}
