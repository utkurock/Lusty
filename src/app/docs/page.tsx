'use client'

import { useState } from 'react'
import { Copy, ChevronRight, ChevronLeft } from 'lucide-react'

interface Section {
  id: string
  icon?: string
  title: string
  eyebrow: string
  tagline?: string
  body: React.ReactNode
}

interface Group {
  id: string
  label: string
  icon?: string
  items: Section[]
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="leading-relaxed">{children}</p>
)

const H = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-lg font-bold text-ink mt-6 mb-2">{children}</h3>
)

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="px-1.5 py-0.5 bg-card border border-line rounded text-[13px] font-mono">
    {children}
  </code>
)

const Pre = ({ children }: { children: React.ReactNode }) => (
  <pre className="bg-inverse text-cream p-4 rounded text-xs overflow-x-auto my-4 font-mono">
    {children}
  </pre>
)

const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="list-disc pl-5 space-y-1.5 my-3">{children}</ul>
)

// Honest-framing callouts: clearly separate what runs today from the
// trustless Soroban + Reflector architecture, which is T2/T3 roadmap work.
const Today = ({ children }: { children: React.ReactNode }) => (
  <div className="my-4 rounded-lg border-l-4 border-ink bg-card p-4 text-[14px] leading-relaxed">
    <div className="font-mono text-[11px] uppercase tracking-wider text-ink font-bold mb-1.5">
      Where Lusty is today
    </div>
    {children}
  </div>
)

const Roadmap = ({ children }: { children: React.ReactNode }) => (
  <div className="my-4 rounded-lg border-l-4 border-[#eab308] bg-card p-4 text-[14px] leading-relaxed">
    <div className="font-mono text-[11px] uppercase tracking-wider text-[#eab308] font-bold mb-1.5">
      Roadmap — T2 / T3
    </div>
    {children}
  </div>
)

const GROUPS: Group[] = [
  {
    id: 'getting-started',
    label: 'GETTING STARTED',
    icon: '🌟',
    items: [
      {
        id: 'welcome',
        icon: '🛣️',
        title: 'Welcome to Lusty',
        eyebrow: 'GETTING STARTED',
        tagline: 'Lusty is the options yield layer of Stellar.',
        body: (
          <>
            <div className="my-6 rounded-lg overflow-hidden border border-line bg-inverse text-cream aspect-[16/7] flex flex-col items-center justify-center font-mono">
              <div className="text-5xl tracking-[0.3em] font-bold">lusty</div>
              <div className="mt-4 text-xs tracking-[0.25em] text-[#eab308]">
                THE STELLAR OPTIONS YIELD LAYER
              </div>
            </div>
            <P>
              Lusty is a <strong>DeFi options yield venue</strong> on Stellar
              for <strong>covered calls</strong> and{' '}
              <strong>cash-secured puts</strong>, giving depositors a simple way
              to earn yield by monetizing the volatility of XLM and USDC.
            </P>
            <Today>
              Lusty today runs as a <strong>server-settled venue on Stellar
              Classic</strong>. Collateral is held by a protocol-operated
              distributor account; pricing and settlement run server-side
              against a Binance spot feed; positions are recorded in a database.
              It is <strong>custodial and pre-audit (testnet only)</strong>. The
              fully on-chain, non-custodial Soroban version described in the
              roadmap callouts below is <strong>T2/T3 work</strong>, not the
              current deployment.
            </Today>
            <P>
              Lusty makes <strong>option strategies accessible</strong> to anyone
              with a Stellar wallet. You don&apos;t need to understand greeks, manage
              margin, or run delta-hedging bots — you only pick a{' '}
              <strong>strike you&apos;d be happy to sell at</strong> (for calls) or{' '}
              <strong>buy at</strong> (for puts). The protocol quotes a fair
              upfront yield, locks your collateral for one weekly epoch and pays
              the upfront in LUSD the moment you deposit.
            </P>
            <H>Why Lusty exists</H>
            <P>
              In traditional finance, selling options is one of the oldest and
              most reliable sources of structured yield — the{' '}
              <em>volatility risk premium</em>. On Stellar, that yield has
              historically been inaccessible to retail users because there has
              been no native options venue: no AMM, no order book, no vaults. The
              yield that was being harvested off-chain by market makers simply
              never flowed back to XLM and USDC holders.
            </P>
            <P>
              Lusty closes that gap. The depositor always picks the trade and
              always sees the math behind the quote — no off-chain market
              makers, no opaque OTC pricing.
            </P>
            <Roadmap>
              The end-state goal is that every position, strike, quote and
              settlement is on-chain and independently verifiable, with no
              custodian and no counterparty credit risk. That requires the
              Soroban vault contracts and Reflector settlement on the roadmap.
              Until then, settlement is performed server-side by the protocol
              operator.
            </Roadmap>
            <H>What you can do on Lusty</H>
            <List>
              <li>
                <strong>Earn upfront LUSD</strong> on your XLM by selling
                covered calls at one of four strike multipliers.
              </li>
              <li>
                <strong>Earn upfront LUSD</strong> on your LUSD by
                selling cash-secured puts against XLM.
              </li>
              <li>
                Track live APRs, utilization, open interest and settlement
                history on the <Code>/dashboard</Code> and <Code>/research</Code>{' '}
                pages.
              </li>
              <li>
                Compete on the points and leaderboard programs for early
                depositors.
              </li>
            </List>
            <H>Five-second mental model</H>
            <P>
              You are a seller of insurance on XLM. Someone on the other side
              pays you a fixed upfront every week for the right to hand you
              XLM at a low price (puts) or take your XLM away at a high price
              (calls). If the market stays inside your band, you simply keep the
              upfront. If it doesn&apos;t, you get assigned — but you knew the price
              going in and you still keep the upfront.
            </P>
          </>
        ),
      },
      {
        id: 'problem',
        icon: '🐷',
        title: 'Problem',
        eyebrow: 'GETTING STARTED',
        tagline: 'Volatility yield exists on Stellar — but nobody can access it.',
        body: (
          <>
            <P>
              Yield on Stellar today is dominated by two primitives: lending
              markets and AMM liquidity provision. Both are good products, but
              both have hard ceilings on the yield they can produce for
              depositors, and both leave a huge category of structured yield
              completely untapped.
            </P>
            <H>Lending caps out at borrow demand</H>
            <P>
              Lending APR is a function of utilization. When nobody wants to
              borrow, APR collapses — and on Stellar, borrow demand for XLM and
              USDC is structurally low compared to leverage-heavy chains. That
              makes lending a <em>spot-beta + small spread</em> product. Safe,
              but not competitive.
            </P>
            <H>LP positions bleed to impermanent loss</H>
            <P>
              AMM LPing looks attractive on paper but the fees are a thin layer
              on top of a much larger exposure to IL. In volatile markets, LPs
              routinely underperform simply holding the two assets — the yield
              is real, but so is the unrecognized cost.
            </P>
            <H>Volatility yield is missing entirely</H>
            <P>
              On chains with a mature options infrastructure,{' '}
              <strong>selling volatility</strong> is the largest single source of
              structured yield for retail — covered calls, cash-secured puts,
              iron condors and theta vaults collectively manage billions of
              dollars. None of that is available natively to XLM holders. The
              volatility premium is being harvested off-chain, by off-chain
              actors, with off-chain counterparties.
            </P>
            <H>Retail is forced into black-box vaults</H>
            <P>
              Even where options-flavoured vaults exist in DeFi, they tend to
              abstract everything away: users deposit, a manager picks strikes
              off-chain, an OTC market maker quotes a premium, and settlement
              depends on a webhook. The depositor cannot see <em>why</em> the
              APR is what it is, cannot pick their own strike, and cannot verify
              that the premium they were paid was fair.
            </P>
            <P>
              Lusty is a direct response to all four of these problems: a
              four-strikes-per-vault, Black-Scholes priced options venue where
              the depositor always picks the trade and always sees the math —
              server-settled today, with an on-chain, non-custodial rebuild on
              the roadmap.
            </P>
          </>
        ),
      },
      {
        id: 'solution',
        icon: '🦺',
        title: 'Solution: Lusty V1',
        eyebrow: 'GETTING STARTED',
        tagline: 'Two vaults, four strikes, weekly epochs, upfront USDC.',
        body: (
          <>
            <P>
              Lusty V1 ships two product vaults on Stellar and a dynamic
              pricing engine that quotes them in real time. The interface is
              intentionally minimal — the goal is that any user can go from
              wallet-connect to earning premium in under a minute. Today the
              vaults are operated as server-settled Stellar Classic payments;
              the Soroban contract implementation is roadmap work.
            </P>
            <H>The two vaults</H>
            <List>
              <li>
                <strong>Covered call vault (XLM → USDC premium):</strong>{' '}
                deposit XLM, choose an upside strike, receive USDC premium
                instantly.
              </li>
              <li>
                <strong>Cash-secured put vault (USDC → USDC premium):</strong>{' '}
                deposit USDC, choose a downside strike, receive USDC premium
                instantly.
              </li>
            </List>
            <H>Four strikes per vault</H>
            <P>
              At all times each vault exposes exactly four strike multipliers.
              This is a deliberate constraint: it gives users a real choice over
              risk/reward without fragmenting liquidity across dozens of thin
              strikes. The strike grids are:
            </P>
            <Pre>
{`covered call  :  1.15x · 1.30x · 1.45x · 1.60x   (above spot)
cash-secured put:  0.85x · 0.70x · 0.55x · 0.40x   (below spot)`}
            </Pre>
            <H>Weekly epochs</H>
            <P>
              Every position is written into the current epoch, and every epoch
              expires at <strong>Friday 08:00 UTC</strong>. At expiry the
              settlement spot price is snapshotted, every position is compared
              to its strike, and collateral is either returned or converted to
              the other side. Once an epoch is settled, users can immediately
              roll into the next one.
            </P>
            <Today>
              Settlement is performed <strong>server-side</strong> by the
              protocol operator using the Binance spot price at expiry. On-chain
              settlement driven by the <strong>Reflector</strong> oracle is
              roadmap work (T2/T3).
            </Today>
            <H>Pricing you can verify</H>
            <P>
              Premiums are quoted by a Black-Scholes engine with a volatility
              smile, then adjusted by a transparent dynamic-APR layer that
              accounts for vault utilization, inventory skew, strike
              concentration and short-term flow momentum. The engine runs
              server-side today (moving on-chain with the Soroban migration),
              and every component of the final APR is visible on the research
              page.
            </P>
            <H>Quickstart</H>
            <List>
              <li>Connect a Stellar wallet (Freighter, xBull, Albedo, Lobstr, or any WalletConnect-compatible wallet).</li>
              <li>
                Go to <Code>/earn</Code>, pick a vault, pick a strike.
              </li>
              <li>
                Deposit between <Code>100 XLM</Code> and <Code>10,000 XLM</Code>{' '}
                worth of collateral.
              </li>
              <li>Receive the USDC premium in the same transaction.</li>
              <li>
                Wait for Friday 08:00 UTC or check <Code>/dashboard</Code> for
                live PnL and settlement countdown.
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
        icon: '📈',
        title: 'Covered call vault',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Sell upside on your XLM. Keep the upfront no matter what.',
        body: (
          <>
            <P>
              The covered call vault lets XLM holders generate USDC yield by
              selling the right to buy their XLM at a strike price higher than
              the current spot. In exchange they receive an upfront LUSD payment,
              locked in at the moment of deposit.
            </P>
            <H>How a position works</H>
            <P>
              You deposit a whole amount of XLM into the vault and select one
              strike multiplier. The protocol computes the gross premium from
              the Black-Scholes engine, subtracts the 15% revenue share, and
              transfers the net upfront LUSD to your wallet once your deposit
              settles. Your XLM is then locked into the current epoch until
              Friday 08:00 UTC.
            </P>
            <H>Settlement outcomes</H>
            <List>
              <li>
                <strong>
                  Spot at expiry ≤ strike (call expires out of the money):
                </strong>{' '}
                you keep 100% of your XLM <em>and</em> 100% of the upfront. This
                is the base case and the scenario Lusty is optimized for.
              </li>
              <li>
                <strong>
                  Spot at expiry &gt; strike (call is assigned):
                </strong>{' '}
                your XLM is converted to USDC at the strike price. You still
                keep the upfront, and you still keep the LUSD — you have simply
                sold your XLM at a price you already agreed was acceptable. If
                spot keeps running, you&apos;ve given up that extra upside; if spot
                reverses, you&apos;ve effectively sold the top.
              </li>
            </List>
            <H>Strike grid</H>
            <Pre>
{`strike   distance   intuition
1.15x    +15%       highest APR, highest assignment probability
1.30x    +30%       balanced
1.45x    +45%       low assignment risk
1.60x    +60%       tail income, smallest APR`}
            </Pre>
            <H>Who should use it</H>
            <P>
              Covered calls are for XLM holders who are either long-term bullish
              but comfortable trimming at a specific higher price, or who simply
              want to harvest the volatility upfront on an existing XLM bag. If
              you would be upset about selling XLM at <Code>1.15x</Code> spot,
              pick a further strike or use the put vault instead.
            </P>
          </>
        ),
      },
      {
        id: 'cash-secured-put',
        icon: '📉',
        title: 'Cash-secured put vault',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Sell downside. Get paid to bid for XLM at a discount.',
        body: (
          <>
            <P>
              The cash-secured put vault lets LUSD holders earn yield by agreeing
              to buy XLM at a strike price <em>below</em> the current spot. As
              with covered calls, the upfront is paid immediately and is
              yours regardless of how the trade settles.
            </P>
            <H>How a position works</H>
            <P>
              You deposit LUSD into the vault and select one strike multiplier
              under spot. The protocol reserves enough LUSD to buy XLM at your
              chosen strike, pays you the net upfront, and locks your
              collateral into the epoch until Friday 08:00 UTC.
            </P>
            <H>Settlement outcomes</H>
            <List>
              <li>
                <strong>
                  Spot at expiry ≥ strike (put expires out of the money):
                </strong>{' '}
                you keep all your LUSD and all of the upfront. No conversion
                happens.
              </li>
              <li>
                <strong>Spot at expiry &lt; strike (put is assigned):</strong>{' '}
                your LUSD is used to buy XLM at the strike, not at the
                (lower) spot. You still keep the upfront, but you now hold XLM
                bought above market. If you were already planning to bid XLM at
                that level, the upfront is pure extra yield; if you weren&apos;t,
                you&apos;ve taken a mark-to-market loss offset by the upfront.
              </li>
            </List>
            <H>Strike grid</H>
            <Pre>
{`strike   distance   intuition
0.85x    −15%       highest APR, most likely assignment
0.70x    −30%       balanced
0.55x    −45%       strong discount bid
0.40x    −60%       tail income on deep crashes`}
            </Pre>
            <H>Who should use it</H>
            <P>
              The put vault is ideal for users who want XLM exposure but think
              current spot is too rich. Instead of bidding passively on an
              orderbook and hoping to get filled, you get{' '}
              <em>paid upfront</em> to make the bid — and if XLM never touches
              your level, the upfront is free yield on idle LUSD.
            </P>
          </>
        ),
      },
      {
        id: 'pricing',
        icon: '🧮',
        title: 'Pricing model',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Black-Scholes with a volatility smile and a dynamic APR layer.',
        body: (
          <>
            <P>
              Lusty quotes every strike through a two-stage pricing pipeline.
              Stage one produces a <strong>fair</strong> premium using a
              Black-Scholes engine with a curvature adjustment. Stage two
              applies a transparent <strong>dynamic margin</strong> that reflects
              the current state of vault inventory and flow.
            </P>
            <H>Stage 1 — Fair premium</H>
            <Pre>
{`iv_eff(K)    = iv_base × (1 + 6 × ln(K / S)^2)      // volatility smile
gross_prem   = BlackScholes(side, S, K, T, iv_eff)  // per 1 unit collateral
fair_prem    = gross_prem × (1 − 0.15)               // 15% revenue share
APR_fair     = fair_prem / S × (365 / days) × 100`}
            </Pre>
            <P>
              The <Code>iv_eff</Code> term is the volatility smile: it lifts
              implied volatility on strikes far from spot so that deep-OTM tails
              are never systematically under-priced. The multiplier{' '}
              <Code>6</Code> is the curvature and is fixed in V1.
            </P>
            <H>Stage 2 — Dynamic APR margin</H>
            <P>
              On top of the fair APR, the protocol adds a margin whose
              components are:
            </P>
            <List>
              <li>
                <strong>Utilization:</strong> as a strike fills toward its cap,
                APR rises to attract offsetting flow.
              </li>
              <li>
                <strong>Inventory skew:</strong> if the vault is heavy on puts
                vs. calls (or the opposite), the underweighted side pays more.
              </li>
              <li>
                <strong>Strike concentration:</strong> crowded strikes get a
                discount; empty strikes get a premium.
              </li>
              <li>
                <strong>Flow momentum:</strong> sudden directional flow pushes
                APR up on the side absorbing the move.
              </li>
            </List>
            <P>
              Every component is computed from public protocol state and is
              visible on the <Code>/research</Code> page, so depositors can
              always reconstruct why a strike is quoted at the APR they see.
            </P>
          </>
        ),
      },
      {
        id: 'epochs',
        icon: '⏱️',
        title: 'Epochs & settlement',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Weekly, deterministic, server-settled today.',
        body: (
          <>
            <P>
              Lusty operates on a fixed <strong>weekly epoch</strong> schedule.
              Every vault opens, accepts deposits, and settles on the same
              cadence. This keeps the protocol simple, makes APR comparisons
              apples-to-apples across strikes, and lets users always know
              exactly when their capital will be liquid again.
            </P>
            <H>Epoch lifecycle</H>
            <List>
              <li>
                <strong>Open:</strong> a new epoch begins the moment the
                previous one settles. Deposits are accepted at every strike up
                to that strike&apos;s cap.
              </li>
              <li>
                <strong>Active:</strong> existing positions accrue no additional
                yield (premium is already paid upfront); the only live question
                is where spot is trading relative to each strike.
              </li>
              <li>
                <strong>Expiry:</strong> at Friday 08:00 UTC the settlement
                price is snapshotted for the epoch. From that moment on, every
                position is settleable.
              </li>
              <li>
                <strong>Settle &amp; claim:</strong> the depositor claims to
                release their collateral — in-the-money positions are converted
                at the strike; out-of-the-money positions are returned as-is.
                Claims can be rolled directly into the next epoch.
              </li>
            </List>
            <H>Oracle</H>
            <P>
              Both the live UI tape and the settlement price come from{' '}
              <strong>Binance</strong> today: the public websocket drives the
              UI, and the server reads the Binance spot price at expiry to
              settle the epoch.
            </P>
            <Roadmap>
              Settlement will move to <strong>Reflector</strong>, Stellar&apos;s
              native decentralized oracle, alongside the Soroban contracts.
              At that point the settlement price becomes on-chain and
              independently verifiable, and the UI will label it explicitly as
              the Reflector price for the given epoch.
            </Roadmap>
          </>
        ),
      },
      {
        id: 'fees',
        icon: '💸',
        title: 'Fees',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: '15% revenue share on upfront income. Visible on every quote.',
        body: (
          <>
            <P>
              Lusty takes a <strong>15% revenue share</strong> on the upfront
              of every position. The share is applied before any
              dynamic margin and before the user sees a quoted APR — in other
              words, the number you see on the earn page is the number you
              actually earn.
            </P>
            <H>What you do NOT pay</H>
            <List>
              <li>No deposit fee.</li>
              <li>No withdrawal fee.</li>
              <li>No performance fee.</li>
              <li>No roll / renewal fee.</li>
              <li>No oracle fee.</li>
              <li>No hidden spread between the quoted APR and the settled APR.</li>
            </List>
            <H>Where the 15% goes</H>
            <P>
              In the current testnet phase, 100% of protocol revenue accrues to
              a treasury earmarked for audit, bounty and liquidity
              incentives. A transparent on-chain split (treasury vs. insurance
              buffer vs. stakers) will be introduced alongside the mainnet
              launch and will be documented on this page.
            </P>
          </>
        ),
      },
      {
        id: 'limits',
        icon: '📏',
        title: 'Deposit limits',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'Conservative caps during testnet — scaling with demand.',
        body: (
          <>
            <P>
              During the testnet and early-mainnet phases, all deposits are
              bounded between <Code>100 XLM</Code> and <Code>10,000 XLM</Code>{' '}
              worth of collateral. For the put vault, those bounds are
              converted to USDC at the live spot price at the moment of deposit.
            </P>
            <H>Why the cap exists</H>
            <List>
              <li>
                Protects early epochs from single-whale concentration risk.
              </li>
              <li>
                Keeps settlement gas and contract complexity bounded while the
                protocol is still being battle-tested.
              </li>
              <li>
                Lets the team scale caps intentionally as open interest and
                oracle confidence grow.
              </li>
            </List>
            <H>Scaling policy</H>
            <P>
              Caps are reviewed at the end of every epoch. When a strike fills
              its cap without stress (no oracle deviation, no settlement delay,
              no reverts), the cap for that strike is raised for the next
              epoch. Cap changes are always announced on the Lusty Twitter
              account before they take effect.
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
              Every action on Lusty earns points that feed a single Season 0
              leaderboard. Points are not a token and have no on-chain
              representation today — they exist to rank early users for
              priority allocation at mainnet and to reward consistent
              participation rather than one-shot deposits.
            </P>
            <H>Scoring components</H>
            <List>
              <li>
                <strong>Deposit points (1×):</strong> 1 point for every{' '}
                <Code>$1</Code> of collateral deposited into a Lusty vault.
                Counted on the USD notional at the moment of deposit.
              </li>
              <li>
                <strong>Upfront points (3×):</strong> points earned on the LUSD
                upfront you actually collected, multiplied by 3 to reward
                taking on real assignment risk instead of parking capital in
                deep-OTM strikes.
              </li>
              <li>
                <strong>Swap points (0.5×):</strong> 0.5 points for every{' '}
                <Code>$1</Code> of swap volume. Swapping earns fewer points
                than vault deposits but still rewards protocol activity and
                liquidity usage.
              </li>
            </List>
            <H>Points formula</H>
            <Pre>
{`points = deposit_usd × 1 + upfront_lusd × 3 + swap_volume_usd × 0.5`}
            </Pre>
            <H>Where to track them</H>
            <P>
              Live ranks, your personal score, and the full top-of-table sit
              on the <Code>/leaderboard</Code> page. Your position updates
              in real time after every transaction.
            </P>
            <H>What points unlock</H>
            <P>
              At mainnet, the top of the Season 0 leaderboard receives
              priority access: earlier deposit windows, higher per-strike caps
              before public lift, and a share of the launch incentive pool.
              Final allocation rules will be published before the season
              closes.
            </P>
          </>
        ),
      },
      {
        id: 'lusd',
        icon: '🪙',
        title: 'LUSD stablecoin',
        eyebrow: 'PROTOCOL AND PRODUCT',
        tagline: 'What LUSD is, how it is issued and redeemed, and what backs it.',
        body: (
          <>
            <P>
              <strong>LUSD</strong> is the unit of account inside Lusty. It is
              the asset you receive as your upfront premium, the collateral for
              the cash-secured put vault, and one side of the{' '}
              <Code>XLM ↔ LUSD</Code> swap. It is a Stellar asset issued by the
              Lusty issuer account and is intended to track <strong>1 USD</strong>.
            </P>
            <Today>
              On testnet, LUSD is a <strong>faucet-issued test token with no
              real-world backing</strong>. The 1:1 USD value is a convention for
              pricing and accounting, not a redeemable claim on reserves. Do not
              treat testnet LUSD as money — it exists so users can exercise the
              full deposit → premium → settle → swap loop without real funds.
            </Today>

            <H>Issuance (mint)</H>
            <P>
              LUSD is minted by the <strong>issuer account</strong> and
              distributed from the <strong>distributor account</strong>. On
              testnet, new LUSD enters circulation through three paths:
            </P>
            <List>
              <li>
                <strong>Faucet:</strong> the <Code>/api/faucet/lusd</Code>{' '}
                endpoint sends test LUSD to a user so they can try the put vault
                and swap.
              </li>
              <li>
                <strong>Upfront premium:</strong> when you open a position, the
                net premium is paid to you in LUSD from the distributor.
              </li>
              <li>
                <strong>Swap:</strong> swapping XLM into LUSD draws LUSD from the
                distributor at the live Binance spot price.
              </li>
            </List>

            <H>Redemption (burn / exit)</H>
            <P>
              There is no fiat redemption window. You exit LUSD the same way you
              entered it — by <strong>swapping LUSD back to XLM</strong> through
              the <Code>/swap</Code> page at the live spot price (0.1% spread),
              or by holding it as put-vault collateral until settlement. LUSD
              returned to the distributor is held there; the issuer can burn
              supply by clawing returned LUSD back to the issuer account.
            </P>

            <H>Reserve & backing</H>
            <P>
              The peg is maintained operationally, not by an over-collateralized
              reserve:
            </P>
            <List>
              <li>
                <strong>Testnet (today):</strong> no reserve. LUSD is
                faucet-issued and priced at 1 USD by convention. The swap is the
                only price-discovery surface, and it quotes against the Binance
                XLM/USD feed.
              </li>
              <li>
                <strong>Mainnet (planned):</strong> LUSD upfront and swap
                liquidity is intended to be backed by a{' '}
                <strong>USDC reserve</strong> held by the protocol, with the
                reserve ratio and attestation method documented here before any
                mainnet launch.
              </li>
            </List>
            <Roadmap>
              The trust-minimized design — LUSD mint/burn governed by a Soroban
              contract against an on-chain USDC reserve, with a verifiable
              reserve ratio — arrives with the Soroban migration (T2/T3). Until
              then, supply and reserve are operator-controlled.
            </Roadmap>

            <H>Stress scenarios</H>
            <List>
              <li>
                <strong>Distributor drained:</strong> if the distributor runs
                low on LUSD or XLM, swaps and premium payouts in that direction
                are paused rather than partially filled. Caps and the per-epoch
                limits exist to keep payout obligations inside the distributor
                balance.
              </li>
              <li>
                <strong>Peg break:</strong> because testnet LUSD has no reserve,
                its &quot;value&quot; is purely the swap rate. If the swap is paused,
                LUSD cannot be marked to USD until it resumes. On mainnet, a peg
                deviation would be defended by the USDC reserve and, failing
                that, by halting new issuance.
              </li>
              <li>
                <strong>Price feed down:</strong> if the Binance feed is
                unreachable, deposits, claims and swaps are rejected (no stale
                fallback price), so no LUSD is minted or redeemed at a wrong
                rate while the peg reference is unavailable.
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
        icon: '⚠️',
        title: 'Assignment risk',
        eyebrow: 'RISK',
        tagline: 'Selling options is a directional commitment — understand it.',
        body: (
          <>
            <P>
              Lusty is not a magic yield box. When you sell a covered call or a
              cash-secured put, you are making a specific, enforceable promise:
              you will sell XLM at a given strike, or you will buy XLM at a
              given strike, if the oracle says so at expiry. The upfront
              upfront is the compensation for that promise.
            </P>
            <H>What assignment feels like</H>
            <List>
              <li>
                <strong>Covered call assigned:</strong> you wake up on Friday
                and your XLM has been swapped to USDC at the strike. If spot is
                well above the strike, you&apos;ve given up the extra upside. Your
                downside in that scenario is opportunity cost, not capital loss.
              </li>
              <li>
                <strong>Cash-secured put assigned:</strong> you wake up on
                Friday and your USDC has been swapped into XLM at the strike.
                If spot is well below the strike, you now hold XLM that is
                worth less than what you paid. This is a real mark-to-market
                loss, partly offset by the upfront you were paid.
              </li>
            </List>
            <H>Managing it</H>
            <List>
              <li>
                Pick strikes that reflect levels at which you would{' '}
                <em>actually</em> want to transact — not just the ones with the
                highest APR.
              </li>
              <li>
                Size positions so that a worst-case assignment on a single
                vault would not break your broader portfolio.
              </li>
              <li>
                Diversify across the two vaults rather than going all-in on one
                direction.
              </li>
            </List>
          </>
        ),
      },
      {
        id: 'smart-contract',
        icon: '🔐',
        title: 'Custody & contract risk',
        eyebrow: 'RISK',
        tagline: 'Custodial and server-settled today — please read this carefully.',
        body: (
          <>
            <Today>
              There are <strong>no Soroban smart contracts deployed yet</strong>.
              Today Lusty is <strong>custodial</strong>: your deposit is sent to
              a protocol-operated distributor account, and pricing, settlement
              and payouts are executed <strong>server-side</strong>. You are
              trusting the Lusty operator to settle and return collateral
              correctly. This is testnet only, with test XLM and test USDC that
              have no real value.
            </Today>
            <P>
              Because settlement is server-side, the main risks today are{' '}
              <strong>operator risk</strong> (the distributor account and the
              settlement server) and ordinary web-application risk, rather than
              smart-contract bugs. We have hardened the API surface (server-side
              repricing, server-canonical strike binding, replay protection,
              fail-closed caps), but a custodial server is a trust assumption
              you should weigh.
            </P>
            <Roadmap>
              The Soroban vault, pricing and settlement contracts are{' '}
              <strong>in development</strong>. When they ship they will be
              externally audited before any mainnet launch, followed by a bug
              bounty, and contract upgrades will sit behind a timelock. Until
              the audit report is published on this page, assume the eventual
              contracts may contain bugs.
            </Roadmap>
            <H>What this means for you</H>
            <List>
              <li>
                The current deployment runs on <strong>Stellar testnet</strong>.
                Deposits use test XLM and test USDC from the testnet faucet,
                which have no real value.
              </li>
              <li>
                The mainnet launch will be gated behind a public audit from a
                reputable firm, followed by a bug bounty program.
              </li>
              <li>
                Upgrades will be announced in advance and a timelock will be
                introduced before any contract upgrade can go live on mainnet.
              </li>
            </List>
            <H>Responsible testing</H>
            <P>
              We actively welcome users breaking the protocol on testnet.
              Report any issue — from UI glitches to potential contract
              exploits — through the channels listed in the{' '}
              <strong>Resources → Security</strong> section. During testnet,
              responsible disclosure is rewarded with points on the leaderboard.
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
        id: 'stack',
        icon: '🧰',
        title: 'Tech stack',
        eyebrow: 'RESOURCES',
        tagline: 'Everything Lusty is built on.',
        body: (
          <>
            <P>
              Lusty is a full-stack DeFi application. This page lists every
              meaningful dependency the protocol and the frontend currently
              rely on. If something is not on this list, Lusty does not use it.
            </P>
            <H>Blockchain (today)</H>
            <List>
              <li>
                <strong>Stellar Classic</strong> — settlement layer for all
                collateral and LUSD upfront transfers, via a protocol-operated
                distributor account.
              </li>
              <li>
                <strong>Binance API</strong> — server-side spot price used for
                pricing and settlement, plus a public websocket for the live UI
                tape.
              </li>
            </List>
            <H>Blockchain (roadmap — T2/T3)</H>
            <List>
              <li>
                <strong>Soroban</strong> — Stellar&apos;s smart-contract runtime;
                the Lusty vault, pricing and settlement contracts are in
                development in Rust, not yet deployed.
              </li>
              <li>
                <strong>Reflector</strong> — decentralized Stellar-native oracle
                planned for on-chain settlement prices at epoch expiry.
              </li>
            </List>
            <H>Smart-contract tooling</H>
            <List>
              <li>
                <strong>@stellar/stellar-sdk</strong> — Horizon / Soroban RPC
                client used by the frontend to build and submit transactions.
              </li>
              <li>
                <strong>@creit.tech/stellar-wallets-kit</strong> — unified
                wallet connector for Freighter, xBull, Albedo, Lobstr and
                WalletConnect.
              </li>
            </List>
            <H>Frontend</H>
            <List>
              <li>
                <strong>Next.js 14</strong> (App Router) — framework for the
                earn, dashboard, research and docs pages.
              </li>
              <li>
                <strong>React 18</strong> — UI runtime.
              </li>
              <li>
                <strong>TypeScript 5</strong> — strict mode across the entire
                codebase.
              </li>
              <li>
                <strong>Tailwind CSS</strong> — styling, design tokens and the
                cream/black theme.
              </li>
              <li>
                <strong>lightweight-charts</strong> (TradingView) — powers the
                price and APR charts on the research page.
              </li>
              <li>
                <strong>lucide-react</strong> — icon set.
              </li>
            </List>
            <H>Price oracle</H>
            <List>
              <li>
                <strong>Binance REST API</strong> — server-side spot price for
                upfront calculation and settlement (<Code>XLMUSDT</Code> ticker).
                If the feed is unavailable, transactions are rejected rather
                than falling back to a stale price.
              </li>
              <li>
                <strong>Binance WebSocket</strong> — client-side live tape for
                the research page and UI price display. Purely cosmetic — never
                influences settlement.
              </li>
            </List>
          </>
        ),
      },
      {
        id: 'official-links',
        icon: '🔗',
        title: 'Official links',
        eyebrow: 'RESOURCES',
        body: (
          <>
            <P>
              These are the only channels the Lusty team posts from. Anything
              else is not us.
            </P>
            <List>
              <li>
                Website — <Code>lusty.finance</Code>
              </li>
              <li>
                App — <Code>app.lusty.finance</Code>
              </li>
              <li>
                Docs — <Code>docs.lusty.finance</Code> (this site)
              </li>
              <li>
                Twitter / X — <Code>@lustyfinance</Code>
              </li>
              <li>
                GitHub — <Code>github.com/lustyfinance</Code>
              </li>
              <li>
                Discord — invite in the footer of the main site.
              </li>
            </List>
          </>
        ),
      },
      {
        id: 'oracle',
        icon: '🔮',
        title: 'Oracle & price feed',
        eyebrow: 'RESOURCES',
        body: (
          <>
            <P>
              Lusty uses the <strong>Binance public API</strong> as its price
              oracle for all upfront calculations and settlement. The server
              fetches the live <Code>XLMUSDT</Code> spot price from Binance at
              the moment of every deposit, claim and swap.
            </P>
            <H>Safety mechanism</H>
            <P>
              If the Binance price feed is unreachable or returns invalid data,
              all financial transactions (deposit, claim, swap) are
              automatically rejected with a <Code>price feed unavailable</Code>{' '}
              error. There is no hardcoded fallback price — this prevents
              any transaction from executing at a stale or incorrect price.
            </P>
            <P>
              The frontend streams live spot from the Binance public websocket
              for responsiveness. This stream drives the UI price display and
              the TradingView chart on the research page.
            </P>
          </>
        ),
      },
      {
        id: 'contracts',
        icon: '📜',
        title: 'Important addresses',
        eyebrow: 'RESOURCES',
        body: (
          <>
            <P>
              Testnet addresses used by the protocol. Mainnet addresses
              will be added to this page after the audit and launch.
            </P>
            <H>Stellar accounts</H>
            <Pre>
{`LUSD issuer          :  GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6
LUSD distributor     :  GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6`}
            </Pre>
            <List>
              <li>
                <strong>LUSD issuer</strong> — mints the LUSD stablecoin used
                for upfront payments and put vault collateral.
              </li>
              <li>
                <strong>Distributor</strong> — the vault account. User
                deposits (XLM for covered calls, LUSD for cash-secured puts)
                are sent here. Upfront and settlement payouts are disbursed
                from it.
              </li>
            </List>
            <H>Soroban contracts</H>
            <Pre>
{`USDC (SAC)           :  CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
Covered call vault   :  TBD — deploying before mainnet
Cash-secured put     :  TBD — deploying before mainnet`}
            </Pre>
            <P>
              The vault logic currently runs as server-side Stellar classic
              payments through the distributor account. Soroban smart contracts
              for on-chain vault management, pricing and settlement are in
              development and will be deployed before mainnet launch.
            </P>
            <P>
              Always verify addresses from this page or the official
              Twitter before interacting.
            </P>
          </>
        ),
      },
      {
        id: 'security',
        icon: '🛡️',
        title: 'Security',
        eyebrow: 'RESOURCES',
        body: (
          <>
            <P>
              Lusty is pre-audit and explicitly testnet-only. We take
              responsible disclosure seriously and will credit (and reward)
              anyone who finds and reports a real issue.
            </P>
            <H>Reporting a vulnerability</H>
            <List>
              <li>
                Email — <Code>security@lusty.finance</Code> (PGP key published
                on the main site).
              </li>
              <li>
                Do not open a public GitHub issue for a suspected vulnerability.
              </li>
              <li>
                Include a minimal reproduction and, if possible, a suggested fix.
              </li>
            </List>
            <H>Scope</H>
            <List>
              <li>Soroban contract code in the <Code>lustyfinance</Code> org.</li>
              <li>Pricing engine math and oracle handling.</li>
              <li>Frontend issues that could cause funds loss or misrepresentation of state.</li>
            </List>
          </>
        ),
      },
      {
        id: 'terms',
        icon: '📄',
        title: 'Terms of Service',
        eyebrow: 'RESOURCES',
        tagline: 'Last updated: 2026-04-09.',
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
              During the current server-settled testnet phase, Lusty is{' '}
              <strong>custodial</strong>: deposits are held by a
              protocol-operated distributor account and settlement is executed
              server-side. You are trusting the Lusty operator to settle and
              return collateral correctly. The non-custodial model — collateral
              held by Soroban contracts the user interacts with directly, with
              no ability for the team to freeze or seize positions — is a
              roadmap target that arrives with the Soroban migration.
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
              unaudited. Do not send real funds. Any real funds sent to testnet
              addresses may be unrecoverable.
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
              These terms may be updated. Material changes will be announced on
              the official Twitter account and reflected here with an updated
              date at the top of the document.
            </P>
          </>
        ),
      },
      {
        id: 'privacy',
        icon: '🔏',
        title: 'Privacy Policy',
        eyebrow: 'RESOURCES',
        tagline: 'Last updated: 2026-04-09.',
        body: (
          <>
            <P>
              Lusty is designed around the principle of collecting as little
              personal data as possible. This policy describes what we do and
              don&apos;t collect, and how the information is used.
            </P>
            <H>What we do NOT collect</H>
            <List>
              <li>We do not collect names, emails, phone numbers or KYC data from Service users.</li>
              <li>We do not require account creation or sign-up.</li>
              <li>We do not sell or share user data with third parties for advertising.</li>
              <li>We do not link wallet addresses to off-chain identities.</li>
            </List>
            <H>What is inherently public</H>
            <P>
              Every transaction you make with Lusty contracts is recorded on
              the Stellar ledger and is publicly visible. This is a property of
              the blockchain, not of Lusty. Your wallet address, your position,
              and your settlements are queryable by anyone using a block
              explorer.
            </P>
            <H>What we collect incidentally</H>
            <List>
              <li>
                <strong>Analytics:</strong> basic, aggregated and anonymized
                pageview statistics on the frontend to understand which pages
                are used. No wallet addresses are linked to these events.
              </li>
              <li>
                <strong>RPC logs:</strong> when you use the app, your browser
                sends RPC requests to a Stellar Horizon / Soroban RPC endpoint.
                Those endpoints may log your IP independently of Lusty, under
                their own privacy policies.
              </li>
              <li>
                <strong>Error reporting:</strong> uncaught frontend errors may
                include a minimal stack trace sent to a monitoring service for
                debugging. We strip wallet addresses before transmission where
                technically possible.
              </li>
            </List>
            <H>Cookies</H>
            <P>
              Lusty uses only strictly necessary cookies (wallet-connection
              state, theme preference). There are no third-party advertising or
              tracking cookies.
            </P>
            <H>Your rights</H>
            <P>
              Because we do not collect personal data tied to identity, there
              is generally no personal record to rectify or delete. If you
              believe we hold data about you, contact{' '}
              <Code>privacy@lusty.finance</Code> and we will respond.
            </P>
          </>
        ),
      },
      {
        id: 'brand',
        icon: '🎨',
        title: 'Brand kit',
        eyebrow: 'RESOURCES',
        body: (
          <>
            <P>
              If you want to write about Lusty, integrate with it, or list it on
              an aggregator, please use the assets and colors on this page
              rather than screenshotting the app.
            </P>
            <H>Name &amp; wordmark</H>
            <List>
              <li>
                Always written as <Code>lusty_</Code> in the logo form and{' '}
                <strong>Lusty</strong> in prose.
              </li>
              <li>Never all-caps unless part of a headline.</li>
              <li>Never hyphenated, never spaced.</li>
            </List>
            <H>Colors</H>
            <Pre>
{`background (cream)  : #e8e4d9
surface (paper)     : #f0ece3
ink (near-black)    : #1a1a1a
accent (gold)       : #eab308
muted text          : #6b6560
border              : #c4bfb2`}
            </Pre>
            <H>Typography</H>
            <List>
              <li>
                Display &amp; body: <strong>Inter</strong>.
              </li>
              <li>
                Mono &amp; code: <strong>JetBrains Mono</strong>.
              </li>
            </List>
            <P>
              Logo files and press assets can be requested at{' '}
              <Code>brand@lusty.finance</Code>.
            </P>
          </>
        ),
      },
    ],
  },
]

export default function DocsPage() {
  const allItems = GROUPS.flatMap((g) => g.items)
  const [activeId, setActiveId] = useState(allItems[0].id)
  const activeIdx = Math.max(0, allItems.findIndex((s) => s.id === activeId))
  const active = allItems[activeIdx]
  const prev = activeIdx > 0 ? allItems[activeIdx - 1] : null
  const next = activeIdx < allItems.length - 1 ? allItems[activeIdx + 1] : null

  return (
    <div className="bg-surface min-h-screen text-ink">
      <div className="max-w-7xl mx-auto px-6 py-10 grid lg:grid-cols-[260px_1fr] gap-10">
        {/* Sidebar */}
        <aside className="font-mono text-xs space-y-6 lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto pr-2">
          {GROUPS.map((g) => (
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
                        onClick={() => setActiveId(s.id)}
                        className={
                          'w-full text-left py-1.5 px-2 rounded-md transition ' +
                          (isActive
                            ? 'bg-inverse text-[#eab308]'
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
            <div className="text-[#eab308] font-mono text-xs font-bold tracking-wider">
              {active.eyebrow}
            </div>
            <button className="flex items-center gap-1.5 text-xs border border-line bg-card hover:bg-surface rounded-md px-3 py-1.5 font-mono text-ink-3">
              <Copy size={12} />
              Copy
              <ChevronRight size={12} className="rotate-90" />
            </button>
          </div>

          <h1 className="text-4xl font-bold mb-3">{active.title}</h1>
          {active.tagline && (
            <p className="text-ink-2 text-lg mb-2">{active.tagline}</p>
          )}

          <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-ink-3">
            {active.body}
          </div>

          <div className="mt-12 pb-20 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {prev ? (
              <button
                onClick={() => setActiveId(prev.id)}
                className="group flex items-center gap-3 text-left border border-line bg-card hover:bg-surface rounded-lg p-4 transition"
              >
                <ChevronLeft
                  size={20}
                  className="text-ink-2 group-hover:text-ink transition shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2">
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
                onClick={() => setActiveId(next.id)}
                className="group flex items-center gap-3 text-right border border-line bg-card hover:bg-surface rounded-lg p-4 transition sm:col-start-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-ink-2">
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
