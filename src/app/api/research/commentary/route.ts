import { NextResponse } from 'next/server'
import { ensureSchema, getPool } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'

// Desk note for the research page. Every 3 hours we call Gemini with the
// latest XLM ticker and persist the note to Supabase. Reads always come
// from the DB — if the newest row is < 3h old we serve it, otherwise we
// generate a new one, insert it, and return that.

export const dynamic = 'force-dynamic'

interface Ticker {
  price: number
  change24hPct: number
  high24h: number
  low24h: number
  volume24h: number
  quoteVolume24h: number
}

interface Commentary {
  bias: 'bullish' | 'bearish' | 'neutral'
  headline: string
  bullets: string[]
  suggestion: string
}

const CACHE_TTL_MS = 1 * 60 * 60 * 1000 // 1 hour

interface TechSnapshot {
  closes1h: number[]
  closes1d: number[]
  ma20_1h: number
  ma50_1h: number
  ma20_1d: number
  rsi14_1h: number
  trend1h: 'up' | 'down' | 'flat'
  trend1d: 'up' | 'down' | 'flat'
  pctFromHigh7d: number
  pctFromLow7d: number
  high7d: number
  low7d: number
  recentCandles: { t: number; o: number; h: number; l: number; c: number; v: number }[]
}

function sma(arr: number[], n: number): number {
  if (arr.length < n) return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length)
  const slice = arr.slice(-n)
  return slice.reduce((a, b) => a + b, 0) / n
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0
  let losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gains += d
    else losses -= d
  }
  const avgG = gains / period
  const avgL = losses / period
  if (avgL === 0) return 100
  const rs = avgG / avgL
  return 100 - 100 / (1 + rs)
}

function trendOf(closes: number[]): 'up' | 'down' | 'flat' {
  if (closes.length < 10) return 'flat'
  const first = closes[closes.length - 10]
  const last = closes[closes.length - 1]
  const delta = (last - first) / first
  if (delta > 0.01) return 'up'
  if (delta < -0.01) return 'down'
  return 'flat'
}

async function fetchKlines(interval: '1h' | '1d', limit: number): Promise<number[][] | null> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=XLMUSDT&interval=${interval}&limit=${limit}`,
      { cache: 'no-store' }
    )
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

async function fetchTech(): Promise<TechSnapshot | null> {
  const [k1h, k1d] = await Promise.all([fetchKlines('1h', 168), fetchKlines('1d', 30)])
  if (!k1h || !k1d) return null
  const closes1h = k1h.map((c) => parseFloat(c[4] as any))
  const closes1d = k1d.map((c) => parseFloat(c[4] as any))
  const highs7d = k1h.slice(-168).map((c) => parseFloat(c[2] as any))
  const lows7d = k1h.slice(-168).map((c) => parseFloat(c[3] as any))
  const high7d = Math.max(...highs7d)
  const low7d = Math.min(...lows7d)
  const last = closes1h[closes1h.length - 1]
  const recentCandles = k1h.slice(-12).map((c) => ({
    t: c[0] as number,
    o: parseFloat(c[1] as any),
    h: parseFloat(c[2] as any),
    l: parseFloat(c[3] as any),
    c: parseFloat(c[4] as any),
    v: parseFloat(c[5] as any),
  }))
  return {
    closes1h,
    closes1d,
    ma20_1h: sma(closes1h, 20),
    ma50_1h: sma(closes1h, 50),
    ma20_1d: sma(closes1d, 20),
    rsi14_1h: rsi(closes1h, 14),
    trend1h: trendOf(closes1h),
    trend1d: trendOf(closes1d),
    pctFromHigh7d: ((last - high7d) / high7d) * 100,
    pctFromLow7d: ((last - low7d) / low7d) * 100,
    high7d,
    low7d,
    recentCandles,
  }
}

async function fetchTicker(): Promise<Ticker | null> {
  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/ticker/24hr?symbol=XLMUSDT',
      { cache: 'no-store' }
    )
    if (!r.ok) return null
    const j = await r.json()
    return {
      price: parseFloat(j.lastPrice),
      change24hPct: parseFloat(j.priceChangePercent),
      high24h: parseFloat(j.highPrice),
      low24h: parseFloat(j.lowPrice),
      volume24h: parseFloat(j.volume),
      quoteVolume24h: parseFloat(j.quoteVolume),
    }
  } catch {
    return null
  }
}

// Deterministic fallback so the page never goes blank if Gemini is
// unreachable or no key is configured.
function ruleBasedCommentary(t: Ticker): Commentary {
  const { price, change24hPct, high24h, low24h, quoteVolume24h } = t
  const range = high24h - low24h
  const rangePct = range / low24h
  const positionInRange = range > 0 ? (price - low24h) / range : 0.5

  let bias: Commentary['bias'] = 'neutral'
  if (change24hPct > 2 && positionInRange > 0.6) bias = 'bullish'
  else if (change24hPct < -2 && positionInRange < 0.4) bias = 'bearish'

  const bullets: string[] = [
    `XLM trading at $${price.toFixed(4)}, ${change24hPct >= 0 ? '+' : ''}${change24hPct.toFixed(2)}% on the day.`,
    `24h range $${low24h.toFixed(4)} → $${high24h.toFixed(4)} (${(rangePct * 100).toFixed(2)}% wide), spot sitting in the ${
      positionInRange > 0.7
        ? 'upper third — room to fade'
        : positionInRange < 0.3
        ? 'lower third — dip territory'
        : 'middle of the range'
    }.`,
    `Quote volume ${(quoteVolume24h / 1_000_000).toFixed(1)}M USDT — ${
      quoteVolume24h > 100_000_000
        ? 'well above the 7-day average, conviction-led flow'
        : quoteVolume24h > 40_000_000
        ? 'in line with the 7-day average'
        : 'below the 7-day average, low-conviction tape'
    }.`,
  ]

  const headline =
    bias === 'bullish'
      ? 'Tape is constructive — dips likely to be bought'
      : bias === 'bearish'
      ? 'Momentum is heavy — fading rips has the edge'
      : 'Range-bound tape — premium sellers in control'

  const suggestion =
    bias === 'bullish'
      ? 'Covered calls on closer strikes look attractive here — rally pays a fat premium if the move continues, and the cushion covers a pullback.'
      : bias === 'bearish'
      ? 'Cash-secured puts at deeper strikes get paid well right now. If spot keeps bleeding, you get assigned at a discount to the current tape.'
      : 'Chop favours far-OTM covered calls and puts — decay works in your favour and assignment probability stays low.'

  return { bias, headline, bullets, suggestion }
}

async function geminiCommentary(t: Ticker, tech: TechSnapshot | null): Promise<Commentary | null> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return null

  const techBlock = tech
    ? `
Technical snapshot (computed from Binance XLMUSDT klines — same data TradingView shows):
- Last price: $${t.price.toFixed(4)}
- 1h MA20: $${tech.ma20_1h.toFixed(4)}  |  1h MA50: $${tech.ma50_1h.toFixed(4)}
- 1d MA20: $${tech.ma20_1d.toFixed(4)}
- 1h RSI(14): ${tech.rsi14_1h.toFixed(1)}
- 1h trend (last 10 candles): ${tech.trend1h}
- 1d trend (last 10 candles): ${tech.trend1d}
- 7d high: $${tech.high7d.toFixed(4)} (${tech.pctFromHigh7d.toFixed(2)}% from last)
- 7d low:  $${tech.low7d.toFixed(4)} (${tech.pctFromLow7d.toFixed(2)}% from last)
- Last 12x 1h candles (o/h/l/c/v):
${tech.recentCandles.map((c) => `  ${c.o.toFixed(4)}/${c.h.toFixed(4)}/${c.l.toFixed(4)}/${c.c.toFixed(4)}/${(c.v / 1000).toFixed(0)}k`).join('\n')}`
    : ''

  const prompt = `You are a senior crypto options desk analyst. Read the live XLM (Stellar/USDT) market data below and produce a concise desk note describing what you actually see on the tape — trend, momentum, location within the range, volume conviction, and any notable 1h/1d structure. Be specific: reference real numbers (price, MA, RSI, 7d high/low, % distances). Do not hedge with generic disclaimers.

Respond ONLY with strict JSON (no markdown, no prose outside JSON) matching this TypeScript type:

{
  "bias": "bullish" | "bearish" | "neutral",
  "headline": string,       // 6-10 words, punchy, describes what you see
  "bullets": string[],      // EXACTLY 3 bullets, each 12-22 words, terminal/mono tone, MUST cite concrete numbers from the data (price, MA, RSI, %, range)
  "suggestion": string      // 1-2 sentences. Actionable options-desk idea (covered calls / cash-secured puts / strangles / etc.) consistent with the bias and the observed structure
}

Market data:
- Price: $${t.price.toFixed(4)}
- 24h change: ${t.change24hPct.toFixed(2)}%
- 24h range: $${t.low24h.toFixed(4)} → $${t.high24h.toFixed(4)}
- 24h quote volume: ${(t.quoteVolume24h / 1_000_000).toFixed(1)}M USDT
${techBlock}

Tone: dry, professional, buy-side desk. Describe what the tape is doing. Just the JSON.`

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
        }),
        cache: 'no-store',
      }
    )
    if (!r.ok) return null
    const j = await r.json()
    const text: string | undefined = j?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null
    const parsed = JSON.parse(text)
    if (
      !parsed ||
      !['bullish', 'bearish', 'neutral'].includes(parsed.bias) ||
      typeof parsed.headline !== 'string' ||
      !Array.isArray(parsed.bullets) ||
      typeof parsed.suggestion !== 'string'
    ) {
      return null
    }
    return {
      bias: parsed.bias,
      headline: parsed.headline,
      bullets: parsed.bullets.map((b: any) => String(b)).slice(0, 5),
      suggestion: parsed.suggestion,
    }
  } catch {
    return null
  }
}

function rowToPayload(row: any) {
  return {
    ok: true,
    generatedAt: new Date(row.generated_at).getTime(),
    price: parseFloat(row.price),
    change24hPct: parseFloat(row.change_24h),
    bias: row.bias as Commentary['bias'],
    headline: row.headline as string,
    bullets: row.bullets as string[],
    suggestion: row.suggestion as string,
    source: row.source as string,
  }
}

// Last-resort fallback so the desk notes panel never goes blank, even when
// Binance is unreachable AND the database has nothing cached. The numbers
// are obviously stale (source = 'static') so the UI can flag it if needed.
function staticFallbackPayload() {
  const c = ruleBasedCommentary({
    price: 0.12,
    change24hPct: 0,
    high24h: 0.13,
    low24h: 0.115,
    volume24h: 0,
    quoteVolume24h: 50_000_000,
  })
  return {
    generatedAt: new Date().toISOString(),
    price: 0.12,
    change24h: 0,
    bias: c.bias,
    headline: c.headline,
    bullets: c.bullets,
    suggestion: c.suggestion,
    source: 'static',
  }
}

export async function GET(req: Request) {
  try {
    const rl = rateLimit('commentary:global', 60_000, 30)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `rate limited — retry after ${rl.retryAfter}s` },
        { status: 429 }
      )
    }

    const url = new URL(req.url)
    const force = url.searchParams.get('force') === '1'

    // Try to read latest cached row from DB. DB failure is non-fatal.
    let row: any = null
    let pool: ReturnType<typeof getPool> | null = null
    try {
      await ensureSchema()
      pool = getPool()
      const latest = await pool.query(
        'select * from desk_notes order by generated_at desc limit 1'
      )
      row = latest.rows[0] ?? null
    } catch (dbErr) {
      console.error('commentary: DB read failed', dbErr)
    }

    if (!force && row) {
      const ageMs = Date.now() - new Date(row.generated_at).getTime()
      if (ageMs < CACHE_TTL_MS) {
        return NextResponse.json({ ...rowToPayload(row), cached: true })
      }
    }

    const [ticker, tech] = await Promise.all([fetchTicker(), fetchTech()])
    if (!ticker) {
      // Binance unreachable. Serve stale cache if we have one, otherwise
      // synthesize a static payload so the page never says "no data".
      if (row) {
        return NextResponse.json({ ...rowToPayload(row), cached: true, stale: true })
      }
      return NextResponse.json({ ...staticFallbackPayload(), cached: false, stale: true })
    }

    const fromGemini = await geminiCommentary(ticker, tech)
    const c = fromGemini ?? ruleBasedCommentary(ticker)
    const source = fromGemini ? 'gemini' : 'rules'

    // Try to persist; DB failure must not break the response.
    if (pool) {
      try {
        const inserted = await pool.query(
          `insert into desk_notes (price, change_24h, bias, headline, bullets, suggestion, source)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7)
           returning *`,
          [
            ticker.price,
            ticker.change24hPct,
            c.bias,
            c.headline,
            JSON.stringify(c.bullets),
            c.suggestion,
            source,
          ]
        )
        return NextResponse.json({ ...rowToPayload(inserted.rows[0]), cached: false })
      } catch (insertErr) {
        console.error('commentary: DB insert failed', insertErr)
      }
    }

    // DB unavailable — return computed commentary directly so the UI still works.
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      price: ticker.price,
      change24h: ticker.change24hPct,
      bias: c.bias,
      headline: c.headline,
      bullets: c.bullets,
      suggestion: c.suggestion,
      source,
      cached: false,
    })
  } catch (e: any) {
    console.error('commentary: unexpected error', e)
    // Even on totally unexpected errors, return the static fallback so the UI shows something.
    return NextResponse.json({ ...staticFallbackPayload(), cached: false, stale: true })
  }
}
