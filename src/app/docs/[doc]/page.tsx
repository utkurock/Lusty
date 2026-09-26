import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Markdown, headingsOf } from '@/components/docs/Markdown'

// The guardrail documents, published.
//
// M2-08 and M2-15 write them; this is the criterion that says published rather
// than written. They are rendered from the files in docs/ so the page and the
// repository cannot disagree — see components/docs/Markdown.
//
// The slug never becomes a path. It is looked up in the table below, which is
// the whole of what this route will serve: a filename assembled from a URL is
// how a documentation route turns into a file reader.

const PUBLISHED: Record<string, { file: string; title: string; blurb: string }> = {
  'multi-asset': {
    file: 'MULTI-ASSET.md',
    title: 'Adding an underlying',
    blurb:
      'Every field an asset is declared with, its units, and what happens when it is wrong.',
  },
  'liquidity-routing': {
    file: 'LIQUIDITY-ROUTING.md',
    title: 'Liquidity routing guardrails',
    blurb:
      'What a routed swap may do, what stops it, and what happens when each guardrail fires.',
  },
  adversarial: {
    file: 'ADVERSARIAL.md',
    title: 'Adversarial testnet program',
    blurb: 'Scope, rules of engagement, severity, and what counts as resolved.',
  },
  deployments: {
    file: 'DEPLOYMENTS.md',
    title: 'Testnet deployment manifest',
    blurb: 'Every address the deployment runs on, and how to read it back yourself.',
  },
  reproduce: {
    file: 'REPRODUCE.md',
    title: 'Reproducing every protocol flow',
    blurb: 'Runnable, from a clean checkout, against the deployed instances.',
  },
  reporting: {
    file: 'REPORTING.md',
    title: 'Reporting a finding',
    blurb: 'Where to send one, and the five things it needs.',
  },
}

export function generateStaticParams() {
  return Object.keys(PUBLISHED).map((doc) => ({ doc }))
}

export function generateMetadata({ params }: { params: { doc: string } }) {
  const entry = PUBLISHED[params.doc]
  if (!entry) return { title: 'Not found — Lusty' }
  return { title: `${entry.title} — Lusty`, description: entry.blurb }
}

export default function DocPage({ params }: { params: { doc: string } }) {
  const entry = PUBLISHED[params.doc]
  if (!entry) notFound()

  const source = readFileSync(join(process.cwd(), 'docs', entry.file), 'utf8')
  const headings = headingsOf(source).filter((h) => h.depth === 2)

  return (
    <div className="max-w-content mx-auto px-6 py-10 grid lg:grid-cols-[260px_1fr] gap-10">
      <nav className="hidden lg:block">
        <div className="sticky top-24">
          <div className="label mb-3">Contents</div>
          <ul className="space-y-1.5 text-body">
            {headings.map((h) => (
              <li key={h.id}>
                <a href={`#${h.id}`} className="text-ink-2 hover:text-ink transition block">
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
          <div className="label mt-8 mb-3">Other documents</div>
          <ul className="space-y-1.5 text-body">
            {Object.entries(PUBLISHED)
              .filter(([slug]) => slug !== params.doc)
              .map(([slug, e]) => (
                <li key={slug}>
                  <Link href={`/docs/${slug}`} className="text-ink-2 hover:text-ink transition block">
                    {e.title}
                  </Link>
                </li>
              ))}
          </ul>
        </div>
      </nav>

      <article className="min-w-0">
        <div className="font-mono text-tiny uppercase tracking-wider text-brand font-bold mb-2">
          Reference
        </div>
        <Markdown source={source} />

        <div className="mt-14 pt-6 border-t border-line flex items-center justify-between text-body">
          <Link href="/docs" className="text-ink-2 hover:text-ink transition">
            ← Product docs
          </Link>
          <Link href="/security" className="text-brand hover:underline">
            Security →
          </Link>
        </div>
      </article>
    </div>
  )
}
