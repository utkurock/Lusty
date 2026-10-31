'use client'
import { useEffect, useRef, useState } from 'react'
import { Check, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'

/*
 * The earn flow in a browser window, under the hero.
 *
 * The window starts tipped back and straightens as it scrolls into view. Inside
 * it the product runs end to end, on a loop: from the list of books the cursor
 * opens XLM, picks the strike, enters 10,000 XLM, the page scrolls to the
 * button, the deposit goes in, and the upfront lands. Every screen is a real
 * capture of the app at one moment (public/landing/flow-*), shown as a
 * connected wallet would see it, and the toast's figure is the upfront that
 * capture showed. The loop pauses off screen; reduced motion gets the first
 * screen, still.
 */

// The window's viewport is the captures' 1472×900 CSS-px clip.
const VIEW = { w: 1472, h: 900 }
// The book screens are taller than the viewport; scrolling shows their foot.
const BOOK_H = 1259
const SCROLL = ((BOOK_H - VIEW.h) / BOOK_H) * 100 // % of the screen's height

// Cursor targets, from the captures' element rects, as % of the viewport.
const at = (x: number, y: number) => ({ x: (x / VIEW.w) * 100, y: (y / VIEW.h) * 100 })
const SPOTS = {
  rest: at(820, 420),
  xlmRow: at(1276, 679),
  strike: at(590, 408),
  amount: at(300, 568),
  earn: at(736, 974 - (BOOK_H - VIEW.h)),
}

const SCREENS = [
  { src: '/landing/flow-1-overview.jpg', alt: 'Lusty earn screen listing the XLM and BTC covered-call books with their APR range.', h: VIEW.h },
  { src: '/landing/flow-2-book.jpg', alt: 'The XLM book: four strikes with their APR, the deposit field empty.', h: BOOK_H },
  { src: '/landing/flow-3-filled.jpg', alt: 'The XLM book with 10,000 XLM entered, the upfront received, and the earn button.', h: BOOK_H },
]

const UPFRONT = '+5.28 LUSD'

type Step = { ms: number; screen: number; cursor: keyof typeof SPOTS; scrolled?: boolean; click?: boolean; toast?: boolean; hidden?: boolean }

// The flow, beat by beat. A step's `ms` is how long it holds; a cursor move
// takes most of the step it is set on. The loop goes round by fading the
// list back in over the book.
const STEPS: Step[] = [
  { ms: 600, screen: 0, cursor: 'rest', hidden: true },
  { ms: 500, screen: 0, cursor: 'rest' },
  { ms: 1100, screen: 0, cursor: 'xlmRow' },
  { ms: 450, screen: 0, cursor: 'xlmRow', click: true },
  { ms: 700, screen: 1, cursor: 'xlmRow' },
  { ms: 1000, screen: 1, cursor: 'strike' },
  { ms: 450, screen: 1, cursor: 'strike', click: true },
  { ms: 900, screen: 1, cursor: 'amount' },
  { ms: 450, screen: 1, cursor: 'amount', click: true },
  { ms: 700, screen: 2, cursor: 'amount' },
  { ms: 1300, screen: 2, cursor: 'earn', scrolled: true },
  { ms: 450, screen: 2, cursor: 'earn', scrolled: true, click: true },
  { ms: 2600, screen: 2, cursor: 'earn', scrolled: true, toast: true },
  { ms: 500, screen: 2, cursor: 'earn', scrolled: true, hidden: true },
]

export function ProductMockup() {
  const ref = useRef<HTMLDivElement>(null)
  const [p, setP] = useState(0)
  const [still, setStill] = useState(false)
  const [inView, setInView] = useState(false)
  const [i, setI] = useState(0)
  const [clicks, setClicks] = useState(0)

  // One read of the window's place on screen drives both the tilt, which
  // straightens as it scrolls in, and whether the flow runs at all.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStill(true)
      setP(1)
      return
    }
    let raf = 0
    const read = () => {
      raf = 0
      const el = ref.current
      if (!el) return
      const { top, bottom } = el.getBoundingClientRect()
      const vh = window.innerHeight
      setInView(bottom > 0 && top < vh)
      // The window loads already in view, its top about two thirds down, so
      // the straightening starts a quarter-screen above the fold and ends
      // with the window's top near the top of the screen: on load it is
      // still visibly tipped, and it lands flat as it is read.
      setP(Math.min(1, Math.max(0, (vh * 0.75 - top) / (vh * 0.55))))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read)
    }
    read()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    if (still || !inView) return
    const t = setTimeout(() => {
      const next = (i + 1) % STEPS.length
      if (STEPS[next].click) setClicks(c => c + 1)
      setI(next)
    }, STEPS[i].ms)
    return () => clearTimeout(t)
  }, [i, inView, still])

  const step = still ? STEPS[0] : STEPS[i]
  const spot = SPOTS[step.cursor]
  const moveMs = Math.round(STEPS[i].ms * 0.85)
  const transform = `rotateX(${(1 - p) * 22}deg) scale(${0.94 + 0.06 * p})`

  return (
    <div ref={ref} className="relative" style={{ perspective: '1400px' }}>
      {/* A backlight: the window lit from behind, evenly round every edge
          rather than from its top, and tipped with it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-[6%] origin-top rounded-[48px] bg-[radial-gradient(ellipse_at_center,rgba(234,179,8,.34),rgba(234,179,8,.12)_50%,transparent_72%)] blur-3xl"
        style={{ transform, opacity: 0.5 + 0.5 * p }}
      />

      <div
        className="relative origin-top overflow-hidden rounded-xl border border-[#eab308]/20 bg-card shadow-[0_0_0_1px_rgba(234,179,8,.06),0_0_60px_-12px_rgba(234,179,8,.35),0_30px_80px_-20px_rgba(0,0,0,.8)] will-change-transform"
        style={{
          transform,
          maskImage: 'linear-gradient(to bottom, black 86%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 86%, transparent 100%)',
        }}
      >
        {/* Window chrome: the three lights and the address, which follows
            the flow from the list to the book. */}
        <div className="flex h-9 items-center gap-3 border-b border-line-light bg-surface-2 px-3 sm:h-10 sm:px-4">
          <div className="flex gap-1.5" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#eab308]/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e]/70" />
          </div>
          <div className="mx-auto flex min-w-0 items-center gap-1.5 rounded-full border border-line-light bg-surface px-3 py-1 font-mono text-micro text-ink-2 sm:px-4 sm:text-tiny">
            <Lock size={10} className="shrink-0 text-ink-faint" />
            <span className="truncate">lusty.finance/earn{step.screen > 0 ? '/xlm' : ''}</span>
          </div>
          <div className="w-[42px]" aria-hidden />
        </div>

        {/* The viewport: the screens stacked, one showing at a time. */}
        <div className="relative overflow-hidden" style={{ aspectRatio: `${VIEW.w} / ${VIEW.h}` }}>
          {SCREENS.map((s, n) => {
            const shown = n === step.screen
            return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={s.src}
              src={s.src}
              alt={shown ? s.alt : ''}
              aria-hidden={!shown}
              width={2070}
              height={Math.round((2070 * s.h) / VIEW.w)}
              className="absolute inset-x-0 top-0 block h-auto w-full"
              style={{
                opacity: shown ? 1 : 0,
                transform: `translateY(${shown && step.scrolled ? -SCROLL : 0}%)`,
                // A dissolve, not a crossfade: the incoming screen fades in on
                // top while the outgoing one stays solid underneath, and only
                // then drops out and goes back to its top. Two half-faded
                // screens would let the dark page through, and a hidden one
                // scrolling home would be seen.
                zIndex: shown ? 1 : 0,
                transition: shown
                  ? 'opacity 450ms ease, transform 1100ms cubic-bezier(.65, 0, .35, 1)'
                  : 'opacity 0s linear 450ms, transform 0s linear 450ms',
              }}
            />
            )
          })}

          {!still && (
            <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
              {/* The deposit confirming: the upfront, paid. */}
              <div
                className={cn(
                  'absolute right-[3%] top-[5%] flex items-center gap-2.5 rounded-sm border border-accent-green/30 bg-surface/95 px-3 py-2 shadow-menu backdrop-blur transition-all duration-500 sm:gap-3 sm:px-4 sm:py-3',
                  step.toast ? 'translate-y-0 opacity-100' : '-translate-y-3 opacity-0'
                )}
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-green/15 text-accent-green sm:h-8 sm:w-8">
                  <Check size={14} strokeWidth={3} />
                </span>
                <span className="text-left">
                  <span className="block text-micro uppercase tracking-[0.08em] text-ink-2 sm:text-tiny">Upfront received</span>
                  <span className="num block font-display text-caption text-accent-green sm:text-head-sm">{UPFRONT}</span>
                  <span className="hidden text-tiny text-ink-faint sm:block">10,000 XLM · covered call</span>
                </span>
              </div>

              {/* A ring opens wherever the cursor presses. */}
              {clicks > 0 && (
                <span
                  key={clicks}
                  className="mock-ring absolute h-8 w-8 rounded-full border-2 border-[#eab308]"
                  style={{ left: `${spot.x}%`, top: `${spot.y}%`, translate: '-50% -50%' }}
                />
              )}

              <svg
                viewBox="0 0 24 24"
                className={cn('absolute h-3.5 w-3.5 drop-shadow-[0_2px_4px_rgba(0,0,0,.6)] sm:h-[18px] sm:w-[18px]', step.click && 'mock-press')}
                style={{
                  left: `${spot.x}%`,
                  top: `${spot.y}%`,
                  opacity: step.hidden ? 0 : 1,
                  transition: `left ${moveMs}ms cubic-bezier(.65, 0, .35, 1), top ${moveMs}ms cubic-bezier(.65, 0, .35, 1), opacity 300ms ease`,
                }}
              >
                <path d="M4 2.5 L4 19 L8.6 14.8 L11.6 21.5 L14.4 20.3 L11.4 13.6 L17.6 13.6 Z" fill="#fff" stroke="#111" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
