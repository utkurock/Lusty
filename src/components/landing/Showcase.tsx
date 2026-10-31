'use client'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/*
 * The landing page's two-up: the strike ladder on the left, the deposit on
 * the right. Both are pictures of the product with one worked example's
 * numbers in them, and each says so; neither reads a live quote.
 *
 * The two halves share one picked strike, which steps up the ladder on a
 * slow loop so the ticket's upfront and the pin on the chart move together.
 * A click on a strike takes over from the loop; reduced motion never starts it.
 * Nothing snaps between strikes: the figures count across, the ticket's
 * highlight slides, and the chart's level glides to the new strike.
 *
 * The ticket's side switches both halves: a put's ladder sits below spot,
 * so the pins glide down under the price and the ticket asks for cash.
 */

type Side = 'call' | 'put'

// One example per side over a ten-day Friday expiry: 10,000 XLM written as a
// covered call, or $1,800 of cash written as a put.
const LADDERS: Record<Side, { otm: string; strike: number; apr: number; upfront: number }[]> = {
  call: [
    { otm: '+2%', strike: 0.184, apr: 63.53, upfront: 31.26 },
    { otm: '+6%', strike: 0.19, apr: 49.23, upfront: 24.23 },
    { otm: '+12%', strike: 0.202, apr: 28.32, upfront: 13.93 },
    { otm: '+20%', strike: 0.216, apr: 13.89, upfront: 6.83 },
  ],
  put: [
    { otm: '−2%', strike: 0.176, apr: 58.4, upfront: 28.8 },
    { otm: '−6%', strike: 0.169, apr: 41.7, upfront: 20.56 },
    { otm: '−12%', strike: 0.158, apr: 24.1, upfront: 11.88 },
    { otm: '−20%', strike: 0.144, apr: 11.6, upfront: 5.72 },
  ],
}

const DEPOSIT: Record<Side, [string, string]> = {
  call: ['10,000', 'XLM'],
  put: ['1,800', 'USD'],
}

const RUNGS = LADDERS.call.length

const STEP_MS = 3000
const GLIDE_MS = 700
const EASE = 'cubic-bezier(.16, 1, .3, 1)'

/** `target`, approached over GLIDE_MS on an ease-out instead of jumped to. */
function useGlide(target: number) {
  const [value, setValue] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = from.current
    if (start === target) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target
      setValue(target)
      return
    }
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / GLIDE_MS)
      const v = start + (target - start) * (1 - Math.pow(1 - k, 3))
      from.current = v
      setValue(v)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return value
}

// The dot field: a price path drawn as a matrix, its area below in fading dots.
const COLS = 56
const ROWS = 26
const GAP = 10

/** The path's height at column `i`, 0 at the bottom of the field, 1 at the top. */
function level(i: number) {
  return SPOT + 0.07 * Math.sin(i / 5.5) + 0.03 * Math.sin(i / 1.9 + 1) + 0.02 * Math.sin(i / 11)
}

/* The level the ladder is quoted from. The path wanders at most 0.12 either
   side of it, so the price keeps moving without ever crossing the nearest
   strike on either side. */
const SPOT = 0.45

/* Each strike's distance from spot, above it for calls and below for puts,
   and where its pin sits across the field. Neighbouring strikes alternate
   sides so their pins never stack on a phone. */
const OFFSETS = [0.13, 0.22, 0.31, 0.4]
const LEFTS = [52, 10, 56, 14]
const levelOf = (side: Side, i: number) => SPOT + (side === 'call' ? OFFSETS[i] : -OFFSETS[i])

const rowOf = (v: number) => Math.round((1 - v) * (ROWS - 1))
const pct = (row: number) => `${((row * GAP + GAP / 2) / (ROWS * GAP)) * 100}%`

/** The field with the path `t` columns along: the tape scrolls by stepping `t`. */
function dotsAt(t: number) {
  const dots: { x: number; y: number; o: number; top: boolean }[] = []
  for (let i = 0; i < COLS; i++) {
    const top = rowOf(level(t + i))
    for (let r = top; r < ROWS; r++) {
      dots.push({ x: i * GAP + GAP / 2, y: r * GAP + GAP / 2, o: Math.max(0.08, 0.5 - (r - top) * 0.045), top: r === top })
    }
  }
  return dots
}

const TAPE_MS = 700

function DotLadder({ side, picked }: { side: Side; picked: number }) {
  const ladder = LADDERS[side]
  const glide = `top ${GLIDE_MS}ms ${EASE}`

  // The price never stops: one new column every TAPE_MS, the oldest leaving.
  const [t, setT] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setT(n => n + 1), TAPE_MS)
    return () => clearInterval(id)
  }, [])
  const dots = useMemo(() => dotsAt(t), [t])
  const spotRow = rowOf(level(t + COLS - 1))
  return (
    <div className="relative w-full" style={{ aspectRatio: `${COLS * GAP} / ${ROWS * GAP}` }}>
      <svg viewBox={`0 0 ${COLS * GAP} ${ROWS * GAP}`} className="absolute inset-0 h-full w-full" aria-hidden>
        {dots.map(d => (
          <circle
            key={`${d.x}-${d.y}`}
            cx={d.x}
            cy={d.y}
            r={d.top ? 1.9 : 1.5}
            fill={d.top ? 'rgb(var(--ink))' : 'rgb(var(--ink-2))'}
            opacity={d.top ? 0.9 : d.o}
          />
        ))}
      </svg>

      {/* The ladder's levels. Drawn as boxes rather than SVG lines so a switch
          of side can glide them, which an SVG line's coordinates cannot. */}
      {OFFSETS.map((_, i) => (
        <div
          key={i}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[#eab308]/25"
          style={{ top: pct(rowOf(levelOf(side, i))), transition: glide }}
        />
      ))}

      {/* The picked strike's level, gliding from one strike to the next. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 h-px -translate-y-1/2 bg-[#eab308]/70 shadow-[0_0_12px_2px_rgba(234,179,8,.35)]"
        style={{ top: pct(rowOf(levelOf(side, picked))), transition: glide }}
      />

      {/* Spot, riding the end of the path as the tape moves, breathing. */}
      <span
        className="absolute right-0 -translate-y-1/2 translate-x-1/2"
        style={{ top: pct(spotRow), transition: `top ${TAPE_MS}ms ${EASE}` }}
        aria-hidden
      >
        <span className="absolute inset-0 animate-ping rounded-full bg-ink/40" />
        <span className="relative block h-2.5 w-2.5 rounded-full bg-ink" />
      </span>

      {/* The strikes, tagged like pins on a map. */}
      {ladder.map((rung, i) => (
        <span
          key={i}
          className={cn(
            'absolute -translate-y-1/2 whitespace-nowrap rounded-compact border px-2 py-1 font-mono text-micro uppercase tracking-[0.08em] transition-[top,background-color,border-color,color,box-shadow,transform] duration-700 sm:text-tiny',
            i === picked
              ? 'scale-105 border-transparent bg-brand text-[#1a1a1a] shadow-[0_0_24px_rgba(234,179,8,.35)]'
              : 'border-[#eab308]/30 bg-surface text-brand'
          )}
          style={{ top: pct(rowOf(levelOf(side, i))), left: `${LEFTS[i]}%`, transitionTimingFunction: EASE }}
        >
          {rung.otm} · {rung.apr.toFixed(1)}% APR
        </span>
      ))}
    </div>
  )
}

/** The deposit, as a panel: the shape of the earn screen with the example in it. */
function TicketMock({
  side,
  picked,
  onSide,
  onPick,
}: {
  side: Side
  picked: number
  onSide: (s: Side) => void
  onPick: (i: number) => void
}) {
  const ladder = LADDERS[side]
  const q = ladder[picked]
  const [amount, unit] = DEPOSIT[side]
  const strike = useGlide(q.strike)
  const apr = useGlide(q.apr)
  const upfront = useGlide(q.upfront)
  return (
    <div className="w-full max-w-sm rounded-sm border border-line bg-card p-3 text-left shadow-drop">
      <div className="rounded-sm border border-line-light bg-surface-2 p-1">
        <div className="relative grid grid-cols-2 gap-1">
          <span
            aria-hidden
            className={cn(
              'absolute inset-y-0 left-0 w-[calc((100%-0.25rem)/2)] rounded-inner border',
              // A covered call reads green and a put red, softly: a tint and a
              // hairline of the accent, never the full fill.
              side === 'call' ? 'border-accent-green/25 bg-accent-green/10' : 'border-accent-red/25 bg-accent-red/10'
            )}
            style={{
              transform: `translateX(calc(${side === 'put' ? 1 : 0} * (100% + 0.25rem)))`,
              transition: `transform ${GLIDE_MS}ms ${EASE}, background-color ${GLIDE_MS}ms ${EASE}, border-color ${GLIDE_MS}ms ${EASE}`,
            }}
          />
          {(['call', 'put'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => onSide(s)}
              aria-pressed={side === s}
              className={cn(
                'relative py-2 text-center font-mono text-caption transition-colors duration-500',
                side !== s ? 'text-ink-faint hover:text-ink' : s === 'call' ? 'text-[#4ade80]' : 'text-[#f87171]'
              )}
            >
              {s === 'call' ? 'Covered call' : 'Cash-secured put'}
            </button>
          ))}
        </div>
      </div>

      {/* The book, beside the other live one. */}
      <div className="relative -mx-3 my-3 flex items-center gap-2 overflow-hidden px-3">
        <span className="shrink-0 rounded-sm border border-line-light bg-surface-2 px-3 py-2.5 text-caption text-ink-faint opacity-50">
          BTC
        </span>
        <span className="flex flex-1 items-center gap-2 rounded-sm border border-line-interactive bg-raised px-3 py-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/xlm.png" alt="" className="h-4 w-4 rounded-full" />
          <span className="text-caption text-ink">XLM · Friday</span>
          <span className="ml-auto num text-caption text-ink">10d</span>
        </span>
      </div>

      <div className="flex items-baseline justify-between rounded-sm border border-line-light bg-surface-2 px-3 py-2.5">
        <span className="text-caption text-ink-2">Deposit</span>
        <span key={side} className="num text-body text-ink animate-rise">
          {amount} <span className="text-caption text-ink-2">{unit}</span>
        </span>
      </div>

      <div className="mt-3 flex items-baseline justify-between px-0.5">
        <span className="text-caption text-ink-2">Strike</span>
        <span className="num text-caption text-brand">${strike.toFixed(3)}</span>
      </div>
      <div className="mt-2 rounded-sm border border-line-light bg-surface-2 p-1">
        <div className="relative grid grid-cols-4 gap-1">
          {/* One highlight that slides under the picked strike: a quarter of
              the row less the three gaps, moved by its own width plus a gap. */}
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-[calc((100%-0.75rem)/4)] rounded-inner bg-brand"
            style={{ transform: `translateX(calc(${picked} * (100% + 0.25rem)))`, transition: `transform ${GLIDE_MS}ms ${EASE}` }}
          />
          {ladder.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPick(i)}
              aria-pressed={i === picked}
              className={cn(
                'relative rounded-inner py-1.5 text-center num text-tiny transition-colors duration-500',
                i === picked ? 'text-[#1a1a1a]' : 'text-ink-faint hover:text-ink'
              )}
            >
              {s.otm}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-1.5 px-0.5">
        <div className="flex justify-between">
          <span className="label">Upfront, paid now</span>
          <span className="num text-body text-accent-green">${upfront.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="label">APR</span>
          <span className="num text-body text-ink">{apr.toFixed(2)}%</span>
        </div>
      </div>

      <Link
        href="/earn"
        className="press mt-4 block rounded-sm bg-brand py-3 text-center font-mono text-body text-[#1a1a1a]"
      >
        Earn upfront
      </Link>
      <div className="mt-2 text-center text-micro text-ink-faint">Example quote</div>
    </div>
  )
}

function Column({
  eyebrow,
  title,
  body,
  children,
}: {
  eyebrow: string
  title: React.ReactNode
  body: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-6 pb-12 pt-16 text-center sm:px-10 md:pb-16 md:pt-20">
      <div className="font-mono text-caption uppercase tracking-[0.2em] text-brand">{eyebrow}</div>
      <h2 className="mt-5 font-display text-head-lg tracking-[-0.03em] text-ink sm:text-hero">{title}</h2>
      <p className="mt-5 max-w-sm text-lead text-ink-2">{body}</p>
      <div className="mt-12 flex w-full flex-1 items-center justify-center">{children}</div>
    </div>
  )
}

export function Showcase() {
  const [side, setSide] = useState<Side>('call')
  const [picked, setPicked] = useState(1)
  const [auto, setAuto] = useState(true)

  useEffect(() => {
    if (!auto || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setPicked(i => (i + 1) % RUNGS), STEP_MS)
    return () => clearInterval(id)
  }, [auto])

  const pick = (i: number) => {
    setAuto(false)
    setPicked(i)
  }

  return (
    <section className="border-y border-line-light">
      <div className="mx-auto grid max-w-[1440px] divide-y divide-line-light border-line-light md:grid-cols-2 md:divide-x md:divide-y-0 min-[1441px]:border-x">
        <Column
          eyebrow="Strikes"
          title={<>Pick your price.<br />See the yield.</>}
          body="Three Fridays open, an APR beside every strike, priced from live volatility."
        >
          <div className="w-full">
            <DotLadder side={side} picked={picked} />
            <div className="mt-3 flex justify-between font-mono text-micro uppercase tracking-[0.08em] text-ink-faint">
              <span>XLM · 30 days</span>
              <span>Example ladder</span>
            </div>
          </div>
        </Column>
        <Column
          eyebrow="Upfront"
          title={<>Deposit it.<br />Get paid now.</>}
          body="The premium reaches your wallet in the same transaction that escrows your collateral."
        >
          <TicketMock side={side} picked={picked} onSide={setSide} onPick={pick} />
        </Column>
      </div>
    </section>
  )
}
