// Rendering a document from docs/ as a page.
// =========================================
// The published guardrail documents and the files in docs/ have to be the same
// text. The alternative — a page that restates a document — is two copies that
// agree on the day they are written, and the copy a reader trusts is the one
// that is wrong six weeks later. The /security page is already carrying that
// cost deliberately; two more would be a habit.
//
// So this renders the file. It is a small parser rather than a dependency
// because the input is not arbitrary markdown — it is our own documents, and
// what they use is headings, paragraphs, lists, tables, fenced code, rules,
// blockquotes and the four inline forms below. Anything a document uses that
// this does not render is a document to simplify, not a parser to grow.
//
// Server component. No client JS, no sanitiser needed: the input is a file in
// the repository, not anything a request can influence. The route that uses it
// maps a slug to a filename through an explicit table so a URL can never name
// one.

import Link from 'next/link'

type Inline = string | { code: string } | { bold: Inline[] } | { italic: Inline[] } | { href: string; text: string }

/** `code`, **bold**, *italic*, [text](href) — in that precedence. */
function inline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push({ code: m[1] })
    else if (m[2] !== undefined) out.push({ bold: inline(m[2]) })
    else if (m[3] !== undefined) out.push({ italic: inline(m[3]) })
    else out.push({ href: m[5], text: m[4] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (typeof p === 'string') return <span key={i}>{p}</span>
        if ('code' in p)
          return (
            <code
              key={i}
              className="px-1.5 py-0.5 bg-card border border-line rounded text-caption font-code text-ink break-all"
            >
              {p.code}
            </code>
          )
        if ('bold' in p)
          return (
            <strong key={i} className="text-ink font-semibold">
              <Inlines parts={p.bold} />
            </strong>
          )
        if ('italic' in p)
          return (
            <em key={i}>
              <Inlines parts={p.italic} />
            </em>
          )
        // Links between documents keep working: ./LIQUIDITY-ROUTING.md is the
        // route that renders it, and anything else is left alone.
        const internal = /^\.?\/?([A-Z0-9-]+)\.md(#.*)?$/.exec(p.href)
        if (internal) {
          return (
            <Link
              key={i}
              href={`/docs/${internal[1].toLowerCase()}${internal[2] ?? ''}`}
              className="text-brand hover:underline"
            >
              {p.text}
            </Link>
          )
        }
        return (
          <a
            key={i}
            href={p.href}
            className="text-brand hover:underline"
            {...(p.href.startsWith('http')
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
          >
            {p.text}
          </a>
        )
      })}
    </>
  )
}

/** A heading's anchor, so the contents list and deep links work. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`|\*/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export interface Heading {
  depth: number
  text: string
  id: string
}

/** Every `##` and `###`, for a contents list. */
export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    if (fenced) continue
    const m = /^(#{2,3})\s+(.*)$/.exec(line)
    if (m) out.push({ depth: m[1].length, text: m[2], id: slugify(m[2]) })
  }
  return out
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

export function Markdown({ source }: { source: string }) {
  const lines = source.split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return
    blocks.push(
      <p key={key++} className="leading-relaxed text-ink-2 my-3">
        <Inlines parts={inline(buf.join(' '))} />
      </p>,
    )
    buf.length = 0
  }

  const paragraph: string[] = []

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code.
    if (line.startsWith('```')) {
      flushParagraph(paragraph)
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++])
      i++
      blocks.push(
        <pre
          key={key++}
          className="scroll-slim bg-inverse text-cream p-4 rounded text-caption leading-relaxed overflow-x-auto my-4 font-code whitespace-pre"
        >
          {body.join('\n')}
        </pre>,
      )
      continue
    }

    // Table: a header row, a divider, then rows.
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      flushParagraph(paragraph)
      const head = tableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].startsWith('|')) rows.push(tableRow(lines[i++]))
      blocks.push(
        <div key={key++} className="scroll-slim overflow-x-auto my-4">
          <table className="w-full text-body">
            <thead>
              <tr className="label border-b border-line">
                {head.map((c, n) => (
                  <th key={n} className="text-left py-2 pr-4 align-bottom">
                    <Inlines parts={inline(c)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n} className="border-b border-line-light last:border-0 align-top">
                  {r.map((c, m) => (
                    <td key={m} className="py-2 pr-4 text-ink-2 leading-relaxed">
                      <Inlines parts={inline(c)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // Lists, bulleted or numbered. A continuation line is indented.
    const bullet = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph(paragraph)
      const ordered = /\d/.test(bullet[2])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i])
        if (m) {
          items.push(m[3])
          i++
          continue
        }
        // Wrapped text belonging to the item above.
        if (/^\s+\S/.test(lines[i]) && items.length > 0) {
          items[items.length - 1] += ' ' + lines[i].trim()
          i++
          continue
        }
        break
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(
        <List
          key={key++}
          className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-2 my-3 text-ink-2 leading-relaxed`}
        >
          {items.map((it, n) => (
            <li key={n}>
              <Inlines parts={inline(it)} />
            </li>
          ))}
        </List>,
      )
      continue
    }

    // Blockquote.
    if (line.startsWith('>')) {
      flushParagraph(paragraph)
      const body: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        body.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <div
          key={key++}
          className="my-5 rounded-lg border-l-4 border-brand bg-card p-4 leading-relaxed text-ink-2"
        >
          <Inlines parts={inline(body.join(' ').trim())} />
        </div>,
      )
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph(paragraph)
      const depth = heading[1].length
      const text = heading[2]
      const id = slugify(text)
      if (depth === 1) {
        blocks.push(
          <h1 key={key++} className="font-display text-head-lg text-ink mb-3">
            <Inlines parts={inline(text)} />
          </h1>,
        )
      } else if (depth === 2) {
        blocks.push(
          <h2
            key={key++}
            id={id}
            className="font-display scroll-mt-24 text-head-md text-ink mt-14 mb-4 pb-2 border-b border-line"
          >
            <Inlines parts={inline(text)} />
          </h2>,
        )
      } else {
        blocks.push(
          <h3 key={key++} id={id} className="font-display scroll-mt-24 text-head-sm text-ink mt-7 mb-2">
            <Inlines parts={inline(text)} />
          </h3>,
        )
      }
      i++
      continue
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph(paragraph)
      i++
      continue
    }

    if (line.trim() === '') {
      flushParagraph(paragraph)
      i++
      continue
    }

    paragraph.push(line.trim())
    i++
  }
  flushParagraph(paragraph)

  return <>{blocks}</>
}
