import Link from 'next/link'
import { allUnderlyings } from '@/lib/assets'

// The published face of docs/ADVERSARIAL.md.
//
// It is a page rather than a link to the file because the criterion is
// "published", and because an attacker who has to clone a repository to find
// out what is in scope will guess instead. The two are kept in step by hand;
// where they differ the file is the one that was edited and this is the bug.
//
// The instance table is the exception: it comes off the registry, so a book
// that is listed, gated or newly deployed cannot be in scope on one surface
// and absent from the other.

const H2 = ({ id, children }: { id: string; children: React.ReactNode }) => (
  <h2
    id={id}
    className="font-display scroll-mt-24 text-head-md text-ink mt-14 mb-4 pb-2 border-b border-line"
  >
    {children}
  </h2>
)
const H3 = ({ children }: { children: React.ReactNode }) => (
  <h3 className="font-display text-head-sm text-ink mt-7 mb-2">{children}</h3>
)
const P = ({ children }: { children: React.ReactNode }) => (
  <p className="leading-relaxed text-ink-2 my-3">{children}</p>
)
const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="px-1.5 py-0.5 bg-card border border-line rounded text-caption font-code text-ink break-all">
    {children}
  </code>
)
const Pre = ({ children }: { children: React.ReactNode }) => (
  <pre className="scroll-slim bg-inverse text-cream p-4 rounded text-caption leading-relaxed overflow-x-auto my-4 font-code whitespace-pre">
    {children}
  </pre>
)
const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="list-disc pl-5 space-y-2 my-3 text-ink-2 leading-relaxed">
    {children}
  </ul>
)
const Warn = ({ children }: { children: React.ReactNode }) => (
  <div className="my-5 rounded-lg border-l-4 border-brand bg-card p-4 text-body leading-relaxed text-ink-2">
    {children}
  </div>
)

const TOC = [
  ['status', '1. Status and scope'],
  ['rules', '2. Rules of engagement'],
  ['classes', '3. The sixteen classes'],
  ['severity', '4. Severity'],
  ['resolved', '5. When a finding is resolved'],
  ['known', '6. Already found, and known limits'],
  ['report', '7. How to report'],
]

/** The money path, settlement, authorization, and the rails — in that order. */
const CLASSES: Array<[string, string, string]> = [
  [
    'The money path',
    'Premium above the quote',
    'Get the vault to pay a premium the pricing engine did not produce, or one it produced for different inputs — a different strike, tenor, ladder, utilization or book.',
  ],
  [
    '',
    'Escrow mismatch',
    'Open a position that escrows less than the payout it can claim, or that the contract records as escrowing something it does not hold.',
  ],
  [
    '',
    'Solvency break',
    'Drive any instance to a state where balance(payout) − escrowed(opposite) < owed(kind) — the vault owing more than it can pay, in either leg.',
  ],
  [
    '',
    'Limit evasion',
    'Exceed max_position_*, max_expiry_*, the per-wallet epoch allowance or the monthly capacity, by any route including splitting, racing, or reporting the same position twice.',
  ],
  [
    '',
    'Quoter signature abuse',
    'Get the quoter’s co-signature applied to an invocation it did not authorize — a different contract, function, argument, or anything nested under the call it was shown.',
  ],
  [
    'Settlement',
    'Settlement at the wrong price',
    'Make a position settle against a price other than the oracle’s reading at its own expiry — a stale record, a future one, another book’s feed, or a fabricated one.',
  ],
  [
    '',
    'Outcome inversion',
    'Make a position that should be assigned settle as kept, or the reverse, without moving the underlying price past the strike.',
  ],
  [
    '',
    'Double settlement or replay',
    'Settle a position twice, settle one that is already settled, or make one payout land more than once.',
  ],
  [
    '',
    'Settlement denial',
    'Make a position that is expired and inside the oracle window permanently unsettleable, stranding its collateral.',
  ],
  [
    '',
    'Cross-book confusion',
    'Make one book’s instance act on another’s position, price, feed, escrow or id. Position ids restart at zero in every instance, and this class lives in that gap.',
  ],
  [
    'Authorization and access',
    'Privilege escalation',
    'Perform an admin action (set_limits, quoter-set changes) without the admin multisig, or a quoter action without the quoter key.',
  ],
  [
    '',
    'Session and authentication flaws',
    'Obtain an admin session without holding an allowlisted key — replay a challenge, reuse a nonce, or keep a session past a revocation.',
  ],
  [
    '',
    'Unauthenticated exposure',
    'Reach data or an operation through the HTTP API that should require a session, a signature or a secret — including internal state, configuration, or another user’s positions.',
  ],
  [
    'Protocol funds and rails',
    'Distributor drain',
    'Get the faucet, the swap desk or the USDC bridge to pay out against proof that is forged, replayed, failed, or in an asset it never received.',
  ],
  [
    '',
    'Accounting corruption',
    'Make the deposit ledger, the utilization figure, the capacity bar or the leaderboard report something the chain does not support — duplicated positions, invented volume, or amounts summed across assets.',
  ],
  [
    '',
    'Configuration-shaped failure',
    'Make a check that is satisfied by the deployment rather than by the code stop holding: an asset gated when it should not be, a book served when it should be gated, a limit reconciled against nothing, or a rail whose safety depends on a trustline that does not exist yet.',
  ],
]

const SEVERITY: Array<[string, string]> = [
  [
    'Critical',
    'Collateral can be taken, or the vault can be made insolvent. Anyone can extract value that is not theirs, or a writer can be prevented from ever recovering what they escrowed.',
  ],
  [
    'High',
    'Money moves wrongly but recoverably, or an authorization boundary fails. A premium paid above the quote, a limit evaded, an admin action performed without the admin, a distributor drained.',
  ],
  [
    'Medium',
    'The system reports or enforces something false without moving funds directly: a wrong price on a screen that sizes a decision, an accounting figure that misstates exposure, a gate that fails open.',
  ],
  [
    'Low',
    'A weakness with no demonstrated path to any of the above — a missing bound with durable caps behind it, an information disclosure of published data, a hardening gap.',
  ],
]

export default function SecurityPage() {
  const books = allUnderlyings()

  return (
    <div className="max-w-content mx-auto px-6 py-10 grid lg:grid-cols-[260px_1fr] gap-10">
      <nav className="hidden lg:block">
        <div className="sticky top-24">
          <div className="label mb-3">Contents</div>
          <ul className="space-y-1.5 text-body">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-ink-2 hover:text-ink transition block">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <article className="min-w-0">
        <div className="font-mono text-tiny uppercase tracking-wider text-brand font-bold mb-2">
          Security
        </div>
        <h1 className="font-display text-head-lg text-ink mb-3">
          Adversarial testnet program
        </h1>
        <P>
          An open window in which anyone is invited to attack the deployed Lusty vault on
          Stellar testnet, with the scope, the rules and the severity bar written down
          before it opens rather than argued about afterwards.
        </P>

        <H2 id="status">1. Status and scope</H2>
        <Warn>
          <strong className="text-ink">
            The window is open from 2026-10-06 00:00 UTC to 2026-10-20 23:59 UTC.
          </strong>{' '}
          Fifteen days. Attacking the testnet deployment outside the
          window is not forbidden — it is a public network and the contracts are
          permissionless — but only reports received during the window are triaged against
          the commitments below.
          <br />
          <br />
          It will be announced <strong className="text-ink">publicly</strong>, not to an
          invited list. The point of the exercise is people we did not choose.
        </Warn>
        <P>
          Everything in scope is on <strong className="text-ink">Stellar testnet</strong>.
          There is no mainnet deployment. Every address is published, so nobody has to
          guess what is in scope:
        </P>
        <div className="scroll-slim overflow-x-auto my-4">
          <table className="w-full text-caption font-code">
            <thead>
              <tr className="label border-b border-line">
                <th className="text-left py-2 pr-4">Book</th>
                <th className="text-left py-2 pr-4">Instance</th>
                <th className="text-left py-2">State</th>
              </tr>
            </thead>
            <tbody>
              {books.map((b) => (
                <tr key={b.symbol} className="border-b border-line-light last:border-0">
                  <td className="py-2 pr-4 text-ink">{b.symbol}</td>
                  <td className="py-2 pr-4 text-ink-2 break-all">
                    {b.contracts.vault || '—'}
                  </td>
                  <td className="py-2 text-ink-2">
                    {b.enabled ? 'live' : b.contracts.vault ? 'gated' : 'not deployed'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <P>
          The oracle, the SACs, the admin, the treasury and the quoter set are in the{' '}
          <Link href="/docs/deployments" className="text-brand hover:underline">
            deployment manifest
          </Link>
          , along with the limits each instance enforces and how to read them back off the
          chain yourself. Every protocol flow has a{' '}
          <Link href="/docs/reproduce" className="text-brand hover:underline">
            runnable reproduction
          </Link>
          , so attacking this takes reading rather than guessing.
        </P>
        <Warn>
          <strong className="text-ink">The collateral is not real.</strong> LBTC and LUSD
          are minted by this repository: no reserve, no redemption, no custody claim.
          Testnet XLM comes from a faucet. Nobody loses money here, and that is the point
          of doing this before mainnet rather than after.
          <br />
          <br />
          An attack that succeeds is triaged as worth exactly what it would be worth
          against the same code holding real collateral. An attack that only succeeds{' '}
          <em>because</em> the assets are unbacked is a known limitation, not a finding.
        </Warn>

        <H2 id="rules">2. Rules of engagement</H2>
        <H3>Allowed, and encouraged</H3>
        <List>
          <li>Anything against the deployed contracts, in any order, from any account.</li>
          <li>Anything against the public HTTP API at any rate you like.</li>
          <li>
            Reading every key, id and configuration value that is published — they are
            published so you do not have to guess.
          </li>
          <li>Running the repository yourself, reading the source, and attacking from it.</li>
          <li>Automated tooling, fuzzing and scripted campaigns against the testnet endpoints.</li>
        </List>
        <H3>Out of bounds</H3>
        <List>
          <li>
            <strong className="text-ink">Anything off testnet.</strong> No mainnet, no other
            network, no infrastructure that is not the deployed app and contracts.
          </li>
          <li>
            <strong className="text-ink">The people.</strong> No social engineering, no
            phishing, no contacting anyone under a pretext, no physical access.
          </li>
          <li>
            <strong className="text-ink">The hosts underneath.</strong> The application is
            in scope; the hosting provider, the database vendor, Horizon, the Soroban RPC,
            CoinGecko and Binance are not. If a finding depends on compromising one of
            them, report the dependency rather than doing it.
          </li>
          <li>
            <strong className="text-ink">Denial of service as a goal.</strong>{' '}
            Volume-testing a bound is in scope and welcome; exhausting a shared testnet
            resource so nobody else can work is not. If you are about to send sustained
            load, say so in the report and keep it bounded.
          </li>
          <li>
            <strong className="text-ink">Destroying evidence.</strong> Do not delete or
            overwrite data to prove you could. Show the write is possible and stop.
          </li>
        </List>
        <P>
          <strong className="text-ink">Disclosure:</strong> report first, publish
          afterwards. There is no embargo we will enforce against anyone on a testnet
          deployment — we ask, we do not demand — but a finding we hear about first is a
          finding we can fix before it is a headline.
        </P>

        <H2 id="classes">3. The sixteen classes</H2>
        <P>
          These are the ways this specific system can be made to do the wrong thing. Each
          names what the attack would achieve, because a class nobody can state an outcome
          for is not a class. A real finding that fits none of them is worth reporting
          precisely because it means the scope is wrong.
        </P>
        {CLASSES.map(([group, title, body], i) => (
          <div key={title}>
            {group && <H3>{group}</H3>}
            <div className="my-3 leading-relaxed text-ink-2">
              <span className="font-mono text-caption text-ink font-bold mr-2">
                {i + 1}.
              </span>
              <strong className="text-ink">{title}.</strong> {body}
            </div>
          </div>
        ))}

        <H2 id="severity">4. Severity</H2>
        {SEVERITY.map(([level, body]) => (
          <div key={level} className="my-3 leading-relaxed text-ink-2">
            <strong className="text-ink">{level}.</strong> {body}
          </div>
        ))}
        <P>
          Severity is assigned by us on receipt, stated back to the reporter, and argued
          about if they disagree. A report that claims a level and shows a reproduction
          supporting it will generally get the level it claims.
        </P>

        <H2 id="resolved">5. When a finding is resolved</H2>
        <P>All five, or it is not closed:</P>
        <List>
          <li>The root cause is identified — not the symptom, the cause.</li>
          <li>A fix is in place.</li>
          <li>A regression test guards it, in the same commit as the fix.</li>
          <li>
            The build is redeployed to testnet, with the new contract id recorded if the fix
            touched Rust.
          </li>
          <li>The original scenario is retried and no longer reproduces.</li>
        </List>
        <P>
          Triage runs continuously rather than at the end of the window. A{' '}
          <strong className="text-ink">Critical</strong> or{' '}
          <strong className="text-ink">High</strong> finding gets a same-day acknowledgement
          and a fix branch, so the window does not become a queue. The milestone&apos;s own
          completion criterion is that no Critical or High remains unresolved — if the
          window produces more than the schedule assumed, the schedule is what moves.
        </P>
        <P>
          Anything Medium left open at the end is published with a mitigation and a
          remediation deadline set before mainnet. Nothing is quietly carried.
        </P>

        <H2 id="known">6. Already found, and known limits</H2>
        <P>
          An unscheduled security pass ran on 2026-09-18 and produced six findings, all
          fixed. They are listed so a report of one is triaged as known rather than counted
          twice — a failed transaction accepted as proof of payment, an asset check
          satisfied only by a trustline, an unauthenticated debug endpoint, a position
          indexable more than once, an authorization tree compared only at the root, and an
          admin allowlist checked one step too early.
        </P>
        <P>These are known and are not findings:</P>
        <List>
          <li>
            LBTC and LUSD are unbacked test assets minted by this repository. The issuer can
            mint more.
          </li>
          <li>
            Testnet XLM comes from a faucet, so the cost of any attack is the transaction
            fee. That is deliberate — it is what makes the window worth running.
          </li>
          <li>
            The rate limiter is durable but approximate at the edge: replicas racing on one
            key can each admit the last slot, and if the database is unreachable it falls
            back to a per-process count. Read-only endpoints stay per-process on purpose.
          </li>
          <li>
            The circuit breaker is one switch for every book. That is the design; a report
            demonstrating that one thin market can be moved to halt the whole desk is a{' '}
            <em>finding</em>, not a limitation.
          </li>
          <li>
            A <Code>set_limits</Code> raised and reverted between two readings passes the
            reconciliation. The monitor reads every <Code>limits</Code> event and alerts on
            it, so the change is reported after the fact, not prevented.
          </li>
          <li>
            Retired vault instances are still streamed by the event indexer so old positions
            keep their history. They are not in scope as live contracts.
          </li>
        </List>
        <H3>The shape worth hunting</H3>
        <P>
          Two of the six findings above were the same shape:{' '}
          <strong className="text-ink">
            a check that is satisfied by the deployment rather than by the code.
          </strong>{' '}
          &ldquo;Not native&rdquo; is a real check only while the distributor holds one
          trustline. An unchecked sub-invocation tree is safe only while{' '}
          <Code>open</Code> makes no nested call. Both read as correct, both pass every test
          anybody would think to write, and both fail the moment a configuration changes
          somewhere else entirely.
        </P>

        <H2 id="report">7. How to report</H2>
        <P>
          <strong className="text-ink">Critical or High</strong> — anything that takes
          collateral, breaks solvency, moves money wrongly, or crosses an authorization
          boundary — by email, not a public issue:
        </P>
        <Pre>{`utkukaya.tr@gmail.com
subject: LUSTY SECURITY: <one line>`}</Pre>
        <P>
          <strong className="text-ink">Medium, Low, or anything already public</strong> —
          open an issue on the repository using the <em>Security finding</em> template. The
          full intake, and what happens after, is in{' '}
          <Link href="/docs/reporting" className="text-brand hover:underline">
            reporting a finding
          </Link>
          .
        </P>
        <P>A report needs five things:</P>
        <List>
          <li>
            <strong className="text-ink">The reproduction.</strong> Exact steps someone else
            can follow, and the starting state it needs. A script beats prose.
          </li>
          <li>
            <strong className="text-ink">The transaction hashes</strong> — every one the
            attack submitted, <em>including the ones that failed</em>. A failed transaction
            is evidence, and one already-fixed finding turned on exactly that.
          </li>
          <li>
            <strong className="text-ink">Expected versus actual</strong>, stated separately
            even when it feels obvious.
          </li>
          <li>
            <strong className="text-ink">The severity you are claiming</strong>, with one
            line on why.
          </li>
          <li>
            <strong className="text-ink">Which class it is</strong>, or &ldquo;none of
            them&rdquo;.
          </li>
        </List>
        <P>
          Critical and High are acknowledged the same day; everything else within three
          days. Every finding appears in the final report with its severity, its remediation
          and its retest evidence, credited by whatever name you give us — or not at all, if
          you prefer.
        </P>
        <Warn>
          <strong className="text-ink">There is no bounty.</strong> The collateral is
          unbacked test assets and testnet XLM from a faucet, and we are not going to
          pretend otherwise to make the exercise sound bigger than it is. What there is: a
          system that intends to hold real collateral later, published in full before it
          does, with every address, every script and every known weakness written down so
          that attacking it takes reading rather than guessing.
        </Warn>

        <div className="mt-14 pt-6 border-t border-line flex items-center justify-between text-body">
          <Link href="/architecture" className="text-ink-2 hover:text-ink transition">
            ← Technical architecture
          </Link>
          <Link href="/docs" className="text-brand hover:underline">
            Product docs →
          </Link>
        </div>
      </article>
    </div>
  )
}
