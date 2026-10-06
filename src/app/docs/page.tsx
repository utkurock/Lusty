import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Markdown, headingsOf } from '@/components/docs/Markdown'
import { ArchitectureBody, ARCHITECTURE_TOC } from '@/components/docs/ArchitectureArticle'
import { PUBLISHED_DOCS } from '@/lib/published-docs'
import DocsClient, { type ReferenceSection } from './DocsClient'

// One documentation page.
//
// The reference documents used to open on pages of their own, each with its
// own sidebar, so reading the docs meant moving between two navigations. They
// are sections here now, read from docs/ on the server and handed to the page
// already rendered: the text is still the file, and there is one sidebar.

function referenceDoc(slug: string): ReferenceSection {
  const entry = PUBLISHED_DOCS[slug]
  const raw = readFileSync(join(process.cwd(), 'docs', entry.file), 'utf8')
  // The section carries the title, so the file's own `# Title` is dropped
  // rather than shown twice.
  const source = raw.replace(/^# .*\n+/, '')
  return {
    id: slug,
    title: entry.title,
    tagline: entry.blurb,
    body: <Markdown source={source} />,
    contents: headingsOf(source)
      .filter((h) => h.depth === 2)
      .map((h) => ({ id: h.id, label: h.text })),
  }
}

export default function DocsPage() {
  const docs = Object.fromEntries(
    Object.keys(PUBLISHED_DOCS).map((slug) => [slug, referenceDoc(slug)]),
  )
  return (
    <DocsClient
      reference={{
        architecture: {
          id: 'architecture',
          title: 'Technical architecture',
          tagline: 'The full Stellar architecture: Soroban, Reflector, SAC, multisig.',
          body: <ArchitectureBody />,
          contents: ARCHITECTURE_TOC.map(([id, label]) => ({ id, label })),
        },
        docs,
      }}
    />
  )
}
