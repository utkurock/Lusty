import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'

// Multiple free RSS feeds for XLM/Stellar news — no API key needed.
const FEEDS = [
  {
    url: 'https://news.google.com/rss/search?q=%22Stellar+Lumens%22+OR+XLM+OR+Stellar+crypto&hl=en-US&gl=US&ceid=US:en',
    defaultSource: 'Google News',
    filter: true, // needs keyword filtering
  },
  {
    url: 'https://cointelegraph.com/rss/tag/stellar',
    defaultSource: 'Cointelegraph',
    filter: false, // already Stellar-specific
  },
  {
    url: 'https://news.google.com/rss/search?q=Stellar+DeFi+OR+Soroban+OR+%22Stellar+network%22&hl=en-US&gl=US&ceid=US:en',
    defaultSource: 'Google News',
    filter: true,
  },
]

function pick(xml: string, tag: string, from = 0): { value: string; end: number } | null {
  const open = xml.indexOf(`<${tag}`, from)
  if (open === -1) return null
  const gt = xml.indexOf('>', open)
  const close = xml.indexOf(`</${tag}>`, gt)
  if (gt === -1 || close === -1) return null
  let value = xml.slice(gt + 1, close)
  value = value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
  return { value, end: close + tag.length + 3 }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim()
}

function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}

function parseRssItems(xml: string, defaultSource: string) {
  const items: any[] = []
  let cursor = 0
  while (true) {
    const itemOpen = xml.indexOf('<item>', cursor)
    if (itemOpen === -1) break
    const itemClose = xml.indexOf('</item>', itemOpen)
    if (itemClose === -1) break
    const chunk = xml.slice(itemOpen, itemClose)
    cursor = itemClose + 7

    const title = pick(chunk, 'title')?.value ?? ''
    const link = pick(chunk, 'link')?.value ?? ''
    const pub = pick(chunk, 'pubDate')?.value ?? ''
    const src = pick(chunk, 'source')?.value || defaultSource
    const publishedAt = pub ? Date.parse(pub) : Date.now()

    // Extract thumbnail from media:content or enclosure
    const mediaMatch = chunk.match(/url="(https?:\/\/[^"]+\.(jpg|jpeg|png|webp)[^"]*)"/)
    const imageUrl = mediaMatch?.[1] ?? undefined

    if (!title || !link) continue
    items.push({
      id: hash(link),
      title: stripTags(title),
      source: stripTags(src),
      url: link,
      publishedAt,
      imageUrl,
    })
  }
  return items
}

const STELLAR_REGEX = /stellar|xlm|\blumens?\b|soroban/i

async function fetchFeed(feed: typeof FEEDS[number]): Promise<any[]> {
  try {
    const r = await fetch(feed.url, {
      next: { revalidate: 120 },
      headers: { 'user-agent': 'Mozilla/5.0 lusty/1.0' },
    })
    if (!r.ok) return []
    const xml = await r.text()
    const items = parseRssItems(xml, feed.defaultSource)

    if (feed.filter) {
      return items.filter((it) => STELLAR_REGEX.test(`${it.title} ${it.source}`))
    }
    return items
  } catch {
    return []
  }
}

export async function GET() {
  try {
    const rl = rateLimit('news:global', 60_000, 60)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    // Fetch all feeds in parallel
    const results = await Promise.all(FEEDS.map(fetchFeed))
    const all = results.flat()

    // Deduplicate by title similarity (exact id or very similar title)
    const seen = new Set<string>()
    const deduped = all.filter((item) => {
      if (seen.has(item.id)) return false
      // Also deduplicate by normalized title prefix (first 50 chars)
      const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50)
      if (seen.has(titleKey)) return false
      seen.add(item.id)
      seen.add(titleKey)
      return true
    })

    deduped.sort((a, b) => b.publishedAt - a.publishedAt)

    return NextResponse.json({ ok: true, items: deduped.slice(0, 15) })
  } catch (e: any) {
    return NextResponse.json(
      { error: 'news fetch failed', detail: e?.message ?? 'unknown' },
      { status: 500 }
    )
  }
}
