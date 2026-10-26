'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Copy, ChevronRight, ChevronLeft, ChevronDown } from 'lucide-react'
import { useScrollFade } from '@/components/shared/useScrollFade'

interface Section {
  id: string
  title: string
  eyebrow: string
  tagline?: string
  body: React.ReactNode
  /** Headings inside a long section, for its own contents list. */
  contents?: { id: string; label: string }[]
}

/** A section rendered on the server and handed in whole. */
export interface ReferenceSection {
  id: string
  title: string
  tagline: string
  body: React.ReactNode
  contents: { id: string; label: string }[]
}

export interface ReferenceSections {
  architecture: ReferenceSection
  /** Keyed by slug — see lib/published-docs. */
  docs: Record<string, ReferenceSection>
}

// Old deep links, from before the reference documents were sections here.
const HASH_ALIASES: Record<string, string> = {
  contracts: 'deployments',
  security: 'adversarial',
}

/**
 * The hand-written groups, with the reference documents put where a reader
 * looks for them. They replace two hand-written sections that had drifted from
 * the files: the addresses named retired v2 instances, and the security
 * section sent reports to a mailbox the adversarial program does not use.
 */
function withReference(groups: Group[], ref: ReferenceSections): Group[] {
  const doc = (slug: string, eyebrow: string): Section => ({ ...ref.docs[slug], eyebrow })
  const testnet: Group = {
    id: 'testnet',
    label: 'SECURITY & TESTNET',
    items: [
      doc('adversarial', 'SECURITY & TESTNET'),
      doc('adversarial-report', 'SECURITY & TESTNET'),
      doc('reporting', 'SECURITY & TESTNET'),
      doc('deployments', 'SECURITY & TESTNET'),
      doc('reproduce', 'SECURITY & TESTNET'),
    ],
  }
  const out: Group[] = []
  for (const g of groups) {
    if (g.id !== 'resources') {
      out.push(g)
      continue
    }
    out.push(testnet)
    const items: Section[] = []
    for (const s of g.items) {
      if (s.id === 'architecture') {
        items.push({ ...ref.architecture, eyebrow: 'RESOURCES' })
        items.push(doc('multi-asset', 'RESOURCES'))
        items.push(doc('liquidity-routing', 'RESOURCES'))
        continue
      }
      items.push(s)
    }
    out.push({ ...g, items })
  }
  return out
}

interface Group {
  id: string
  label: string
  items: Section[]
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="leading-relaxed">{children}</p>
)

const H = ({ children }: { children: React.ReactNode }) => (
  <h3 className="font-display text-head-sm text-ink mt-6 mb-2">{children}</h3>
)

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="px-1.5 py-0.5 bg-card border border-line rounded text-caption font-code">
    {children}
  </code>
)

const Pre = ({ children }: { children: React.ReactNode }) => (
  <pre className="scroll-slim bg-inverse text-cream p-4 rounded text-caption overflow-x-auto my-4 font-code">
    {children}
  </pre>
)

const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="list-disc pl-5 space-y-1.5 my-3">{children}</ul>
)

// Honest-framing callouts: clearly separate what runs today from the
// trustless Soroban + Reflector architecture, which is T2/T3 roadmap work.
const Today = ({ children }: { children: React.ReactNode }) => (
  <div className="my-4 rounded-lg border-l-4 border-ink bg-card p-4 text-body leading-relaxed">
    <div className="font-mono text-tiny uppercase tracking-wider text-ink font-bold mb-1.5">
      Where Lusty is today
    </div>
    {children}
  </div>
)

const GROUPS: Group[] = [
  {
    id: 'getting-started',
    label: 'GETTING STARTED',
    items: [
      {
        id: 'welcome',
        title: 'Welcome to Lusty',
        eyebrow: 'GETTING STARTED',
        tagline: 'Covered calls and cash-secured puts on Stellar, premium paid up front.',
        body: (
          <>
            <div className="my-6 rounded-lg overflow-hidden border border-line bg-inverse text-cream aspect-[16/7] flex flex-col items-center justify-center font-mono">
              <div className="text-5xl tracking-[0.3em] font-bold">lusty</div>
              <div className="mt-4 text-caption tracking-[0.25em] text-brand">
                THE STELLAR OPTIONS YIELD LAYER
              </div>
            </div>
            <P>
              Lusty lets you write covered calls and cash-secured puts on XLM
              and BTC. You pick a strike you would be happy to trade at and a
              weekly expiry, deposit collateral, and receive the premium in
              LUSD in the same transaction. You never manage greeks, margin or
              hedges.
            </P>
            <Today>
              Lusty runs on Stellar testnet. The Soroban vault contract (v4)
              escrows every position, in one instance for an XLM book and one
              for a BTC book with LBTC collateral. At expiry anyone can call{' '}
              <Code>settle(id)</Code>, which pays the owner at the Reflector
              oracle&apos;s expiry price. The server only prices and co-signs
              premiums under on-chain caps; it holds no user collateral. LUSD
              and LBTC are unbacked test assets, and an{' '}
              <a href="/docs#adversarial" className="underline hover:text-ink">
                adversarial testnet window
              </a>{' '}
              is open until mainnet.
            </Today>
            <H>What you can do on Lusty</H>
            <List>
              <li>
                Write covered calls on XLM or LBTC, or cash-secured puts with
                LUSD, at one of four strikes, and take the premium in LUSD.
              </li>
              <li>
                Follow positions on <Code>/dashboard</Code> and the market on{' '}
                <Code>/research</Code>.
              </li>
              <li>
                Collect Season 0 points on <Code>/leaderboard</Code>.
              </li>
            </List>
            <H>Five-second mental model</H>
            <P>
              You are selling insurance on XLM or BTC. The buyer pays you a
              fixed premium for the right to take your collateral at a higher
              price (a call) or hand you the underlying at a lower one (a put).
              If the expiry price stays on your side of the strike, your
              collateral comes back; if it crosses, you are assigned at the
              strike you chose. The premium is yours either way.
            </P>
          </>
        ),
      },
      {
        id: 'problem',
        title: 'Problem',
        eyebrow: 'GETTING STARTED',
        tagline: 'Stellar has had no native way to sell options.',
        body: (
          <>
            <P>
              Yield on Stellar comes mostly from lending and AMM liquidity, and
              neither lets a holder sell volatility.
            </P>
            <H>Lending caps out at borrow demand</H>
            <P>
              Lending APR follows utilization. When few people borrow, the rate
              falls.
            </P>
            <H>LP positions bleed to impermanent loss</H>
            <P>
              LP fees sit on top of impermanent loss, and in volatile markets
              LPs can do worse than holding both assets.
            </P>
            <H>Volatility yield is missing entirely</H>
            <P>
              On chains with options markets, covered calls and cash-secured
              puts are a standard source of yield. Stellar has had no native
              options venue, so XLM holders could not collect that premium on
              chain.
            </P>
            <H>Retail is forced into black-box vaults</H>
            <P>
              Option vaults elsewhere usually hide the trade: a manager picks
              the strike, a market maker quotes off chain, and the depositor
              cannot check the premium. On Lusty you pick the strike, the quote
              shows its inputs, and the contract settles against a public
              oracle price.
            </P>
          </>
        ),
      },
      {
        id: 'solution',
        title: 'Solution: Lusty V1',
        eyebrow: 'GETTING STARTED',
        tagline: 'Two books, four strikes a side, rolling Friday expiries, premium up front.',
        body: (
          <>
            <P>
              Lusty lists an XLM book and a BTC book. Each is its own deployment
              of the same vault contract, so collateral, limits and pools never
              mix.
            </P>
            <H>Calls and puts</H>
            <List>
              <li>
                Covered call: deposit XLM (or LBTC), choose a strike above spot,
                receive the premium in LUSD.
              </li>
              <li>
                Cash-secured put: deposit LUSD, choose a strike below spot,
                receive the premium in LUSD.
              </li>
            </List>
            <H>Four strikes per side</H>
            <P>
              Four strikes, as multiples of spot, give a real choice of risk
              without spreading liquidity over many thin strikes.
            </P>
            <Pre>
{`covered call     :  1.02x · 1.06x · 1.12x · 1.20x   (above spot)
cash-secured put :  0.98x · 0.94x · 0.88x · 0.80x   (below spot)`}
            </Pre>
            <H>Rolling weekly expiries</H>
            <P>
              Three expiries are open at a time, on the next Fridays at{' '}
              <strong>08:00 UTC</strong>, about one, two and three weeks out.
              Nothing can be written within two days of an expiry. Each expiry
              has its own capacity, so when one fills another usually has room.
              Settlement uses the Reflector price for the expiry timestamp, so
              when someone settles cannot change the outcome.
            </P>
            <H>Pricing you can verify</H>
            <P>
              The engine prices each strike with Black-76 and a volatility
              smile under a policy ceiling. One computation produces both the
              APR on the earn page and the premium the vault pays.
            </P>
            <H>Quickstart</H>
            <List>
              <li>Connect a Stellar wallet: Freighter, xBull, Albedo or Lobstr.</li>
              <li>
                On <Code>/earn</Code>, pick a book, side, strike and expiry.
              </li>
              <li>
                Enter an amount (a call takes <Code>100</Code> to{' '}
                <Code>10,000 XLM</Code>, or <Code>0.001</Code> to{' '}
                <Code>0.05 LBTC</Code>) and sign. One transaction escrows the
                collateral and pays the premium.
              </li>
              <li>
                Follow the position on <Code>/dashboard</Code> until it settles
                after its Friday expiry.
              </li>
            </List>
          </>
        ),
      },
    ],
  },
  {
    id: 'protocol',
    label: 'PROTOCOL AND PRODUCT',
    items: [
      {
        id: 'covered-call',
        title: 'Covered call vault',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Sell upside on your XLM or BTC. Keep the premium whatever happens.',
        body: (
          <>
            <P>
              The covered call vault pays you LUSD for selling the right to buy
              your collateral at a strike above spot.
            </P>
            <H>How a position works</H>
            <P>
              You deposit XLM (or LBTC) and pick a strike and expiry. The
              quoter co-signs the premium, net of the 10% fee, and one
              transaction escrows your collateral in the vault contract and
              pays you. The collateral stays escrowed until settlement.
            </P>
            <H>Settlement outcomes</H>
            <List>
              <li>
                Expiry price at or below the strike: the call expires
                worthless. Your collateral comes back whole and you keep the
                premium. Lusty is built around this case.
              </li>
              <li>
                Expiry price above the strike: the call is assigned. Your
                collateral goes to the treasury and you receive its value at
                the strike in LUSD, as if you had sold there. You keep the
                premium but give up the rise above the strike.
              </li>
            </List>
            <H>Strike grid</H>
            <Pre>
{`strike   distance   intuition
1.02x    +2%        highest APR, highest assignment probability
1.06x    +6%        balanced
1.12x    +12%       low assignment risk
1.20x    +20%       tail income, smallest APR`}
            </Pre>
            <H>Who should use it</H>
            <P>
              Holders content to sell at a specific higher price, or who want to
              earn on coins they plan to hold anyway. If selling at{' '}
              <Code>1.02x</Code> spot would bother you, pick a further strike.
            </P>
          </>
        ),
      },
      {
        id: 'cash-secured-put',
        title: 'Cash-secured put vault',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Get paid to bid for XLM or BTC below spot.',
        body: (
          <>
            <P>
              The cash-secured put vault pays you to agree to buy the underlying
              at a strike <em>below</em> spot.
            </P>
            <H>How a position works</H>
            <P>
              You deposit LUSD (testnet USDC can be routed into it) and pick a
              strike and expiry. The contract escrows the LUSD and pays the
              premium in the same transaction. The BTC book needs an LBTC
              trustline, since an assigned put pays out LBTC.
            </P>
            <H>Settlement outcomes</H>
            <List>
              <li>
                Expiry price at or above the strike: you get your LUSD back and
                keep the premium.
              </li>
              <li>
                Expiry price below the strike: the put is assigned. Your LUSD
                goes to the treasury and you receive the XLM or LBTC it buys at
                the strike. You keep the premium but hold the underlying above
                market, a loss the premium only partly offsets.
              </li>
            </List>
            <H>Strike grid</H>
            <Pre>
{`strike   distance   intuition
0.98x    −2%        highest APR, most likely assignment
0.94x    −6%        balanced
0.88x    −12%       strong discount bid
0.80x    −20%       tail income on deep crashes`}
            </Pre>
            <H>Who should use it</H>
            <P>
              Anyone who wants XLM or BTC but finds spot too expensive. You are
              paid up front to place the bid, and if the price never reaches
              your strike, the premium is yield on idle LUSD.
            </P>
          </>
        ),
      },
      {
        id: 'pricing',
        title: 'Pricing model',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Black-76 with a volatility smile, under a time-scaled APR ceiling.',
        body: (
          <>
            <P>
              One engine (<Code>src/lib/pricing-server.ts</Code>) prices what
              the earn page shows and what the vault pays. Black-76 sets the
              shape of the ladder; policy sets its level.
            </P>
            <H>Stage 1: fair premium</H>
            <Pre>
{`σ_real  ← realized vol, EWMA λ=0.94
σ_atm   = min(σ_real × 1.10 + 0.03, 1.00)
z       = ln(K / F) / (σ_atm · √T)
σ_K     = σ_atm × ψ(z)                     // volatility smile
F       ← forward from perp funding        // ≈ spot for weeklies
fair    = Black-76(side, F, K, T, σ_K)`}
            </Pre>
            <P>
              XLM has no options market, so the smile shape ψ(z) comes from
              Derive&apos;s BTC and ETH surfaces in standardized moneyness. At
              XLM&apos;s current volatility the 100% cap on σ_atm binds, so
              realized vol does not move the quote today.
            </P>
            <H>Stage 2: the APR ceiling</H>
            <P>
              The nearest strike is pinned to 120% APR, scaled down for shorter
              expiries, and the others fall away in their Black-76 proportion.
              The APR tapers linearly with pool utilization, to half at a full
              pool, and the 10% fee comes off the premium.
            </P>
            <Pre>
{`apr_self   = fair × (1 − 0.20) / capital × 365 / days
apr_ref    = apr_self of the nearest strike
target_top = 120 × min(1, days / days_ref)   // days_ref: farthest open expiry
scale      = min(1, target_top / apr_ref)
apr        = min(apr_self × scale, target_top) × (1 − 0.5 × utilization) × (1 − 0.10)`}
            </Pre>
            <P>
              Unit tests hold two invariants: a writer is never paid above 80%
              of fair value, and no strike, even an off-ladder one, quotes above
              the displayed ceiling. The server derives every input itself and
              ignores any premium a client sends. The contract adds a bound of
              its own: no premium above 20% of the collateral at the oracle
              price.
            </P>
          </>
        ),
      },
      {
        id: 'epochs',
        title: 'Epochs & settlement',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Weekly expiries, settled on chain at the expiry price.',
        body: (
          <>
            <P>
              Three Friday 08:00 UTC expiries are open at once. You choose the
              one that matches when you want your capital back.
            </P>
            <H>Epoch lifecycle</H>
            <List>
              <li>
                An open expiry takes deposits up to its own capacity until{' '}
                <strong>2 days before</strong> it, so the vault never sells
                options in their last hours.
              </li>
              <li>
                An open position accrues nothing; the premium is already paid.
              </li>
              <li>
                At Friday 08:00 UTC the oracle price fixes the outcome.
              </li>
              <li>
                After expiry anyone can call <Code>settle(id)</Code>, and a
                runner does so every two hours. It must happen within about a
                day, while Reflector still holds the expiry price; after that
                the v4 contract refuses to settle and the collateral stays
                escrowed.
              </li>
            </List>
            <H>Oracle</H>
            <P>
              The contract reads <strong>Reflector</strong> for the price at the
              expiry timestamp. Until that record is queryable it accepts the
              latest price only if it is at most an hour old; otherwise it
              reverts. Off-chain sources feed quotes only and never decide a
              settlement.
            </P>
          </>
        ),
      },
      {
        id: 'fees',
        title: 'Fees',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: '10% of the premium, already netted out of every quote.',
        body: (
          <>
            <P>
              Lusty keeps <strong>10% of each premium</strong>, never any
              collateral. Quoted APRs are net of it, so the quote is what you
              receive.
            </P>
            <H>What you do NOT pay</H>
            <List>
              <li>No deposit, withdrawal, performance or settlement fee.</li>
              <li>No gap between the quoted APR and the premium paid.</li>
            </List>
            <H>Where the fee goes</H>
            <P>
              Nowhere: the vault pays 10% less than the engine prices, and that
              amount stays in the book&apos;s cash pool.
            </P>
          </>
        ),
      },
      {
        id: 'limits',
        title: 'Deposit limits',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Conservative testnet caps, enforced by the contract and the quoter.',
        body: (
          <>
            <P>
              A call takes <Code>100</Code> to <Code>10,000 XLM</Code> or{' '}
              <Code>0.001</Code> to <Code>0.05 LBTC</Code>; a put takes up to{' '}
              <Code>10,000</Code> or <Code>1,500 LUSD</Code> on the XLM and BTC
              books. By default the quoter also declines to co-sign past:
            </P>
            <List>
              <li><Code>$50,000</Code> per wallet per book over 30 days;</li>
              <li>
                one position&apos;s maximum per wallet per expiry on each side;
              </li>
              <li>
                <Code>$30,000</Code> sold against one strike over 14 days,
                across all wallets.
              </li>
            </List>
            <P>
              These checks reserve nothing, so racing requests can overshoot one
              by a single position, still inside the contract&apos;s caps.
            </P>
            <H>What the contract enforces</H>
            <P>
              These hold even if the server is compromised. Calls count in the
              underlying, puts in LUSD.
            </P>
            <Pre>
{`                          XLM book    BTC book
max position, call        10,000      0.05
max per expiry, call      500,000     5
max position, put         10,000      1,500
max per expiry, put       500,000     150,000
max premium               20% of collateral at the oracle price`}
            </Pre>
            <P>
              It also refuses any position its pools could not pay on
              assignment.
            </P>
            <H>Changing a limit</H>
            <P>
              <Code>set_limits</Code> needs two of the admin&apos;s three
              signatures and affects new positions only. Before quoting a book,
              the app reads its limits off the contract and refuses the book if
              they disagree.
            </P>
          </>
        ),
      },
      {
        id: 'points',
        title: 'Points & rewards',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'How the Season 0 leaderboard scoring works.',
        body: (
          <>
            <P>
              Deposits, premiums and swaps earn points on one Season 0
              leaderboard. Points are not a token and live only in Lusty&apos;s
              database. They reward steady use over one large deposit.
            </P>
            <H>Scoring components</H>
            <List>
              <li>1 point per <Code>$1</Code> of collateral deposited.</li>
              <li>
                3 points per LUSD of premium collected, which favors strikes
                with real assignment risk.
              </li>
              <li>0.5 points per <Code>$1</Code> of swap volume.</li>
            </List>
            <H>Points formula</H>
            <Pre>
{`points = deposit_usd × 1 + upfront_lusd × 3 + swap_volume_usd × 0.5`}
            </Pre>
            <H>Where to track them</H>
            <P>
              On <Code>/leaderboard</Code>.
            </P>
            <H>What points unlock</H>
            <P>Nothing is promised for points today.</P>
          </>
        ),
      },
      {
        id: 'lusd',
        title: 'LUSD stablecoin',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'What LUSD is, where it comes from, and why it has no backing.',
        body: (
          <>
            <P>
              <strong>LUSD</strong> is the cash of both books: premiums are paid
              in it, puts escrow it, and assigned calls pay out in it. Lusty
              issues it and counts it as <strong>1 USD</strong> by convention.
            </P>
            <Today>
              LUSD is an <strong>unbacked testnet token</strong> with no reserve
              and no redemption, so it lets you run the whole loop without real
              money. On mainnet the cash asset is Circle&apos;s native USDC,
              which the contract already supports. LUSD has no mainnet path.
            </Today>

            <H>Issuance (mint)</H>
            <P>
              A 2-of-3 issuer account mints LUSD. The distributor hands it out
              through the faucet, through the <Code>/swap</Code> desk (XLM to
              LUSD at spot, less a 0.1% spread), and by converting testnet USDC
              one for one to fund puts. Premiums mint nothing: the vault pays
              them from a cash pool the operator funds in advance.
            </P>

            <H>Redemption (burn / exit)</H>
            <P>
              Nothing redeems LUSD for dollars. You exit by swapping back to XLM
              or by holding it as put collateral. LUSD to XLM swaps are capped
              per address by the XLM it put in, by a daily outflow ceiling and
              by a fee floor, so faucet LUSD cannot drain the desk.
            </P>

            <H>Reserve & backing</H>
            <P>
              None on testnet. The swap, quoting live XLM/USD spot, is the only
              place LUSD meets a price. On mainnet USDC replaces LUSD rather
              than backing it.
            </P>

            <H>Stress scenarios</H>
            <List>
              <li>
                The faucet and swap desk pay from the distributor&apos;s capped
                balance and cannot reach vault collateral. The contract refuses
                a position its pool cannot cover.
              </li>
              <li>
                With no reserve, LUSD is worth only the swap rate, and nothing
                marks it while the swap is down.
              </li>
              <li>
                Spot comes from Reflector, then Binance. With neither, quotes and
                swaps are refused. Calls also cannot open on a stale oracle feed;
                puts, already collateralized in cash, keep trading.
              </li>
            </List>
          </>
        ),
      },
    ],
  },
  {
    id: 'risk',
    label: 'RISK',
    items: [
      {
        id: 'assignment',
        title: 'Assignment risk',
        eyebrow: 'RISK',
        tagline: 'Selling an option is a commitment to trade at the strike.',
        body: (
          <>
            <P>
              Writing a call or a put commits you to sell the underlying at the
              strike, or buy it there, if the expiry price crosses it. The
              premium pays for that commitment.
            </P>
            <H>What assignment feels like</H>
            <List>
              <li>
                Assigned call: your collateral became LUSD at the strike. If the
                price ran well past it, you missed that upside, an opportunity
                cost rather than a capital loss.
              </li>
              <li>
                Assigned put: your LUSD became XLM or LBTC at the strike. If the
                price fell well below it, you hold an asset worth less than you
                paid, a real loss the premium only partly covers.
              </li>
            </List>
            <H>Managing it</H>
            <List>
              <li>
                Pick strikes where you would <em>actually</em> trade, not the
                highest APR.
              </li>
              <li>Size positions so the worst assignment would not hurt you.</li>
              <li>Spread across calls and puts.</li>
            </List>
          </>
        ),
      },
      {
        id: 'smart-contract',
        title: 'Custody & contract risk',
        eyebrow: 'RISK',
        tagline: 'Collateral sits in an unaudited testnet contract. Read this before depositing.',
        body: (
          <>
            <Today>
              The vault contract (v4) escrows every position on Stellar testnet.
              Collateral leaves only through <Code>settle(id)</Code>, which
              anyone can call and which pays the owner at the oracle&apos;s
              expiry price. No server path can move it; the pre-custody book was
              settled in full and its payout route deleted. All assets are test
              assets.
            </Today>
            <P>
              The server holds the quoter key, which only co-signs premiums. The
              contract caps each at 20% of the collateral at the oracle price,
              so a stolen key could overpay on positions the thief must
              collateralize but not drain the pools. The 2-of-3 admin can change
              limits and the quoter set, nothing else. Two admin signers plus a
              quoter key could widen the ceiling, which is why the admin and
              quoter are separate accounts.
            </P>
            <H>What this means for you</H>
            <List>
              <li>
                The contract is <strong>not independently audited</strong>; an
                audit is planned before mainnet. Assume it may have bugs.
              </li>
              <li>
                It has no upgrade entrypoint: nobody can change it under an open
                position, and a fix means redeploying and migrating.
              </li>
              <li>
                A position must be settled within about a day of expiry. On v4,
                one left past that window stays escrowed with no admin override.
                The undeployed v5 records the expiry price on chain and releases
                an unpriced position after 30 days.
              </li>
              <li>
                Deposits halt automatically on a volatility spike, oracle stress
                or a per-epoch loss cap, or by hand.
              </li>
            </List>
            <H>Responsible testing</H>
            <P>
              An adversarial testnet window has been open since 2026-10-06 and
              runs until mainnet. Attack within the{' '}
              <a href="/docs#adversarial" className="underline hover:text-ink">
                rules of engagement
              </a>{' '}
              and report through the button on every page or the{' '}
              <a href="/docs#reporting" className="underline hover:text-ink">
                reporting guide
              </a>
              . A valid finding may earn an XLM reward.
            </P>
          </>
        ),
      },
    ],
  },
  {
    id: 'resources',
    label: 'RESOURCES',
    items: [
      {
        // Placeholder: withReference swaps in the architecture document,
        // rendered on the server from components/docs/ArchitectureArticle.
        id: 'architecture',
        title: 'Technical architecture',
        eyebrow: 'RESOURCES',
        body: null,
      },
      {
        id: 'stack',
        title: 'Tech stack',
        eyebrow: 'RESOURCES',
        tagline: 'What Lusty is built on.',
        body: (
          <>
            <P>
              The app keeps its position mirror, replay ledger and leaderboard
              in PostgreSQL (Supabase) and runs on self-hosted Coolify.
            </P>
            <H>Blockchain</H>
            <List>
              <li>
                <strong>Soroban</strong>: the vault contract (Rust, v4), deployed
                twice from one wasm hash for the XLM and BTC books.
              </li>
              <li>
                <strong>Reflector</strong>: the settlement oracle, and the
                server&apos;s first source of live spot.
              </li>
              <li>
                <strong>Stellar Asset Contracts</strong> for XLM, LBTC and LUSD.
              </li>
              <li>
                <strong>Stellar Classic</strong> accounts: the 2-of-3 admin, the
                LUSD and LBTC issuers, and the faucet and swap distributors.
              </li>
            </List>
            <H>In the repository, not yet deployed</H>
            <List>
              <li>Vault v5, with on-chain expiry prices and a 30-day release.</li>
              <li>An ETH book, waiting on a vault instance and an asset issuer.</li>
            </List>
            <H>Smart-contract tooling</H>
            <List>
              <li>
                <strong>@stellar/stellar-sdk</strong>: Horizon and Soroban RPC
                client.
              </li>
              <li>
                <strong>@creit.tech/stellar-wallets-kit</strong>: Freighter,
                xBull, Albedo and Lobstr.
              </li>
            </List>
            <H>Frontend</H>
            <List>
              <li>
                <strong>Next.js 15.5</strong> (App Router), pages and API routes.
              </li>
              <li>
                <strong>React 19.2</strong>.
              </li>
              <li>
                <strong>TypeScript 5</strong>, strict mode.
              </li>
              <li>
                <strong>Tailwind CSS</strong>, dark and cream themes.
              </li>
              <li>
                <strong>lightweight-charts</strong> (TradingView) for research
                charts.
              </li>
              <li>
                <strong>lucide-react</strong> icons.
              </li>
            </List>
            <H>Price oracle</H>
            <List>
              <li>
                <strong>Reflector</strong>: the only settlement source.
              </li>
              <li>
                <strong>Binance REST</strong>: fallback spot, volatility history
                and perp funding.
              </li>
              <li>
                <strong>CoinGecko</strong> and <strong>Bitstamp</strong>:
                fallback volatility history.
              </li>
              <li>
                <strong>Binance WebSocket</strong>: the browser&apos;s live tape,
                display only.
              </li>
            </List>
          </>
        ),
      },
      {
        id: 'official-links',
        title: 'Official links',
        eyebrow: 'RESOURCES',
        body: (
          <>
            <P>
              The Lusty team posts only from these channels. Anything else is
              not us.
            </P>
            <List>
              <li>
                Website and app: <Code>lusty.finance</Code>
              </li>
              <li>
                Docs: <Code>lusty.finance/docs</Code> (this site)
              </li>
              <li>
                Technical architecture:{' '}
                <Code>lusty.finance/docs#architecture</Code>
              </li>
              <li>
                GitHub:{' '}
                <a
                  href="https://github.com/utkurock/Lusty"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-ink"
                >
                  <Code>github.com/utkurock/Lusty</Code>
                </a>
              </li>
            </List>
          </>
        ),
      },
      {
        id: 'oracle',
        title: 'Oracle & price feed',
        eyebrow: 'RESOURCES',
        tagline: 'Reflector settles every position. Off-chain feeds only shape quotes.',
        body: (
          <>
            <P>
              The price that <strong>settles a position</strong> decides
              assignment, so it comes from the <strong>Reflector
              oracle</strong> and the contract reads it itself. Other prices
              only <strong>feed a quote</strong>.
            </P>
            <H>Settlement price: Reflector</H>
            <P>
              <Code>settle(id)</Code> calls Reflector&apos;s{' '}
              <Code>price(asset, timestamp)</Code> for the{' '}
              <strong>expiry timestamp</strong> on the feed&apos;s 300-second
              grid, so settling later changes nothing. Each book reads its own
              feed. Reflector keeps about 24 hours of history; until the expiry
              record is queryable the contract accepts the latest price only if
              it is at most an hour old, and with neither it reverts. Settlement
              therefore has a deadline of about a day, which the runner reports
              for each due position.
            </P>
            <H>Quote inputs: off-chain feeds</H>
            <P>
              Quotes need volatility history and perp funding, which Reflector
              does not carry. Those come from Binance, with CoinGecko and
              Bitstamp as volatility fallbacks. Live spot comes from Reflector,
              then Binance.
            </P>
            <H>Safety mechanism</H>
            <P>
              Every source fails closed: if a needed feed is down or returns bad
              data, the request is refused (a quote answers{' '}
              <Code>price feed unavailable</Code>). There is no hardcoded
              fallback price. The Binance websocket in the browser drives only
              the price display and research chart.
            </P>
          </>
        ),
      },
      {
        id: 'terms',
        title: 'Terms of Service',
        eyebrow: 'RESOURCES',
        tagline: 'Last updated: 2026-10-26.',
        body: (
          <>
            <P>
              By accessing or using the Lusty website, app, documentation, or
              any associated smart contracts (together, the &quot;Service&quot;), you
              agree to the following terms. If you do not agree, do not use
              the Service.
            </P>
            <H>1. Eligibility</H>
            <P>
              You may use the Service only if you are of legal age in your
              jurisdiction and are not a resident of, or located in, a
              jurisdiction where the use of decentralized options protocols is
              prohibited or restricted. You are solely responsible for
              determining whether the Service is legal for you to use.
            </P>
            <H>2. No financial advice</H>
            <P>
              Nothing on this site or in the protocol constitutes financial,
              investment, tax or legal advice. APR figures, strike grids and
              documentation are informational only. You are solely responsible
              for your own decisions.
            </P>
            <H>3. Custody</H>
            <P>
              Collateral is held by the Lusty vault contract, not by the Lusty
              team, and leaves it only through settlement, which anyone can
              trigger and which pays the position&apos;s owner at the
              oracle&apos;s expiry price. The team cannot freeze or seize
              escrowed collateral. On the current contract version, collateral
              not settled within about a day of expiry stays escrowed.
            </P>
            <H>4. Assignment &amp; settlement</H>
            <P>
              By depositing into any vault you explicitly accept that your
              collateral may be converted to the opposite asset at the selected
              strike if the settlement price at Friday 08:00 UTC meets the
              assignment condition. This is the core product behaviour and is
              not a bug.
            </P>
            <H>5. Testnet disclaimer</H>
            <P>
              While Lusty is in its testnet phase, the Service is provided
              strictly for testing and evaluation purposes. Contracts are
              unaudited, and LUSD and LBTC are unbacked test assets. Do not send
              real funds. Any real funds sent to testnet addresses may be
              unrecoverable.
            </P>
            <H>6. No warranty</H>
            <P>
              The Service is provided &quot;as is&quot;, without any warranty of any
              kind, express or implied. The Lusty team makes no representation
              regarding uptime, availability, or accuracy of on-chain or
              off-chain data.
            </P>
            <H>7. Limitation of liability</H>
            <P>
              To the fullest extent permitted by law, the Lusty team, its
              contributors, and its service providers shall not be liable for
              any indirect, incidental, special, consequential or punitive
              damages, or for lost profits, arising out of your use of the
              Service.
            </P>
            <H>8. Changes</H>
            <P>
              These terms may be updated. Changes will appear here with a new
              date at the top.
            </P>
          </>
        ),
      },
      {
        id: 'privacy',
        title: 'Privacy Policy',
        eyebrow: 'RESOURCES',
        tagline: 'Last updated: 2026-10-26.',
        body: (
          <>
            <P>
              Lusty collects as little personal data as it can. This is what it
              collects and why.
            </P>
            <H>What we do NOT collect</H>
            <List>
              <li>No names, emails, phone numbers or KYC data to use the app, and no sign-up.</li>
              <li>We do not sell or share user data for advertising.</li>
              <li>We do not try to link wallet addresses to off-chain identities.</li>
            </List>
            <H>What is inherently public</H>
            <P>
              Every transaction with the Lusty contracts is on the Stellar
              ledger, so your address, positions and settlements are visible to
              anyone with a block explorer.
            </P>
            <H>What we collect incidentally</H>
            <List>
              <li>
                Usage events sent to Lusty&apos;s own server: the page, a random
                browser session id, and your wallet address when connected. No
                third-party analytics.
              </li>
              <li>The address of each wallet you connect.</li>
              <li>Contact details you give in a security report or feedback, so we can reply.</li>
              <li>
                Stellar Horizon and Soroban RPC endpoints your browser calls may
                log your IP under their own policies.
              </li>
            </List>
            <H>Cookies</H>
            <P>
              Lusty sets no cookies. Wallet choice, theme and session id live in
              your browser&apos;s local storage, which you can clear.
            </P>
            <H>Your rights</H>
            <P>
              We hold little data tied to identity, so there is usually nothing
              to correct or delete. If you believe we hold data about you,
              contact the maintainer through the{' '}
              <a href="/docs#reporting" className="underline hover:text-ink">
                reporting guide
              </a>
              .
            </P>
          </>
        ),
      },
      {
        id: 'brand',
        title: 'Brand kit',
        eyebrow: 'RESOURCES',
        body: (
          <>
            <P>
              To write about, integrate or list Lusty, use these names and
              colors rather than screenshots of the app.
            </P>
            <H>Name &amp; wordmark</H>
            <List>
              <li>
                <Code>lusty_</Code> in the logo form, Lusty in prose.
              </li>
              <li>All caps only as part of a headline.</li>
              <li>Never hyphenated, never spaced.</li>
            </List>
            <H>Colors</H>
            <Pre>
{`background (cream)  : #e8e4d9
surface (paper)     : #f0ece3
ink (near-black)    : #1a1a1a
accent (gold)       : #eab308
muted text          : #6b6560
border              : #cac4b7`}
            </Pre>
            <P>
              These are the cream theme&apos;s values. The app defaults to dark
              and switches from the navbar; the gold <Code>#eab308</Code> is
              shared and the rest are tokens that change with the theme.
            </P>
            <H>Typography</H>
            <List>
              <li>Display and body: Jeko, falling back to Inter.</li>
              <li>Code: JetBrains Mono.</li>
            </List>
            <P>
              Request logo files and press assets through the GitHub repository.
            </P>
          </>
        ),
      },
    ],
  },
]

export default function DocsClient({ reference }: { reference: ReferenceSections }) {
  const groups = useMemo(() => withReference(GROUPS, reference), [reference])
  const allItems = groups.flatMap((g) => g.items)
  const [activeId, setActiveId] = useState(allItems[0].id)
  const [copied, setCopied] = useState(false)
  // Below lg the nav would sit above the article as a full screen of links,
  // so it folds behind a toggle there; lg and up it is always shown.
  const [navOpen, setNavOpen] = useState(false)

  // Select a section and reflect it in the URL hash so the address bar always
  // points at the section you're reading (and the Copy button can grab it).
  // A new section starts at its top: without this the window keeps the
  // previous section's scroll offset and opens the next one halfway down.
  const selectSection = (id: string) => {
    setActiveId(id)
    setNavOpen(false)
    if (typeof window !== 'undefined') {
      history.replaceState(null, '', `#${id}`)
      window.scrollTo({ top: 0 })
    }
  }

  // Copy a deep link to the section currently open.
  const copyLink = async () => {
    if (typeof window === 'undefined') return
    const url = `${window.location.origin}${window.location.pathname}#${activeId}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Clipboard API unavailable (insecure context) — fall back to a prompt.
      window.prompt('Copy this link:', url)
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Deep-link support: a hash like /docs#points opens that section directly
  // (e.g. the leaderboard "How points work" button). Also reacts to in-page
  // hash changes so back/forward and shared links land on the right section.
  useEffect(() => {
    const applyHash = () => {
      const raw = window.location.hash.replace('#', '')
      if (!raw) return
      const id = HASH_ALIASES[raw] ?? raw
      if (allItems.some((s) => s.id === id)) {
        setActiveId(id)
        window.scrollTo({ top: 0 })
        return
      }
      // A heading inside a long section: open the section, then scroll to it.
      const owner = allItems.find((s) => s.contents?.some((c) => c.id === id))
      if (owner) {
        setActiveId(owner.id)
        requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView())
      }
    }
    applyHash()
    window.addEventListener('hashchange', applyHash)
    return () => window.removeEventListener('hashchange', applyHash)
    // allItems is derived from props that do not change after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The nav scrolls independently of the page, so its edge fade follows its own
  // scroll position rather than the window's.
  const navRef = useRef<HTMLElement>(null)
  useScrollFade(navRef)

  const activeIdx = Math.max(0, allItems.findIndex((s) => s.id === activeId))
  const active = allItems[activeIdx]
  const prev = activeIdx > 0 ? allItems[activeIdx - 1] : null
  const next = activeIdx < allItems.length - 1 ? allItems[activeIdx + 1] : null

  return (
    <div className="bg-surface min-h-screen text-ink">
      <div className="max-w-content mx-auto px-6 py-10 grid lg:grid-cols-[260px_1fr] gap-6 lg:gap-10">
        {/* Sidebar */}
        {/* The nav is taller than the viewport, so it scrolls on its own. Slim
            bar, and the ends fade into the page so a half-visible item reads as
            "keep going" instead of as a crop. */}
        <button
          type="button"
          onClick={() => setNavOpen((o) => !o)}
          aria-expanded={navOpen}
          aria-controls="docs-nav"
          className="press lg:hidden flex items-center justify-between gap-3 w-full rounded-md border border-line bg-card px-3 py-2.5 font-mono text-caption text-ink"
        >
          <span className="truncate">
            <span className="text-ink-2 uppercase tracking-wider mr-2">Contents</span>
            {allItems[activeIdx]?.title}
          </span>
          <ChevronDown size={16} className={'shrink-0 transition ' + (navOpen ? 'rotate-180' : '')} />
        </button>
        <aside id="docs-nav" ref={navRef} className={(navOpen ? 'block' : 'hidden') + ' lg:block scroll-slim scroll-fade-y font-mono text-caption space-y-6 lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto pr-3 pb-24'}>
          {groups.map((g) => (
            <div key={g.id}>
              <div className="uppercase text-ink-2 mb-2 tracking-wider">
                {g.label}
              </div>
              <ul className="space-y-0.5">
                {g.items.map((s) => {
                  const isActive = activeId === s.id
                  return (
                    <li key={s.id}>
                      <button
                        onClick={() => selectSection(s.id)}
                        className={
                          'press w-full text-left py-1.5 px-2 rounded-md transition ' +
                          (isActive
                            ? 'bg-inverse text-brand'
                            : 'text-ink-3 hover:bg-card')
                        }
                      >
                        {s.title}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}

        </aside>

        {/* Article */}
        <article className="min-w-0">
          <div className="flex items-center justify-between mb-4">
            <div className="text-brand font-mono text-caption font-bold tracking-wider">
              {active.eyebrow}
            </div>
            <button
              onClick={copyLink}
              title="Copy a link to this section"
              className="press flex items-center gap-1.5 text-caption border border-line bg-card hover:bg-raised rounded-md px-3 py-1.5 font-mono text-ink-3 transition"
            >
              <Copy size={12} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>

          <h1 className="font-display text-head-lg mb-3">{active.title}</h1>
          {active.tagline && (
            <p className="text-ink-2 text-lg mb-2">{active.tagline}</p>
          )}

          {active.contents && active.contents.length > 0 && (
            <nav className="mt-6 border border-line bg-card rounded-lg p-4">
              <div className="label mb-2">On this page</div>
              <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-body">
                {active.contents.map((c) => (
                  <li key={c.id}>
                    {/* Scrolls rather than setting the hash: several heading
                        ids are also section ids, and the hash picks sections. */}
                    <button
                      onClick={() => document.getElementById(c.id)?.scrollIntoView({ behavior: 'smooth' })}
                      className="text-left text-ink-2 hover:text-ink transition"
                    >
                      {c.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="mt-6 space-y-4 text-lead leading-relaxed text-ink-3">
            {active.body}
          </div>

          <div className="mt-12 pb-20 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {prev ? (
              <button
                onClick={() => selectSection(prev.id)}
                className="press group flex items-center gap-3 text-left border border-line bg-card hover:bg-raised rounded-lg p-4 transition"
              >
                <ChevronLeft
                  size={20}
                  className="text-ink-2 group-hover:text-ink transition shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="label">
                    Previous
                  </div>
                  <div className="font-semibold text-ink truncate">
                    {prev.title}
                  </div>
                </div>
              </button>
            ) : (
              <div />
            )}
            {next ? (
              <button
                onClick={() => selectSection(next.id)}
                className="press group flex items-center gap-3 text-right border border-line bg-card hover:bg-raised rounded-lg p-4 transition sm:col-start-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="label">
                    Next
                  </div>
                  <div className="font-semibold text-ink truncate">
                    {next.title}
                  </div>
                </div>
                <ChevronRight
                  size={20}
                  className="text-ink-2 group-hover:text-ink transition shrink-0"
                />
              </button>
            ) : (
              <div />
            )}
          </div>
        </article>
      </div>
    </div>
  )
}
