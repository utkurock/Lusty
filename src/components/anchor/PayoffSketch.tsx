'use client'

import { LUSD_CODE } from '@/lib/lusd'

/**
 * What writing a cash secured put actually pays, drawn once.
 *
 * Deliberately without numbers: a chart with figures on it is a quote, and the
 * only honest quote is the live one on the strike screen. This is the shape of
 * the trade — premium kept above the strike, the underlying bought below it —
 * which is the part a newcomer to the market has to hold in their head before
 * any number means anything.
 */
export function PayoffSketch() {
  return (
    <div>
      <svg viewBox="0 0 320 150" className="w-full h-auto" role="img" aria-label="Payoff of a cash secured put writer: the premium is kept above the strike, and below it the underlying is bought at the strike.">
        {/* Axes, quiet: they carry no scale, only a direction. */}
        <line x1="34" y1="128" x2="308" y2="128" stroke="rgb(var(--line))" strokeWidth="1" />
        <line x1="34" y1="18" x2="34" y2="128" stroke="rgb(var(--line))" strokeWidth="1" />

        {/* The strike, the one price the trade is about. */}
        <line x1="176" y1="26" x2="176" y2="128" stroke="rgb(var(--line-2))" strokeWidth="1" strokeDasharray="3 4" />

        <path
          className="payoff"
          d="M 44 126 L 176 70 L 302 70"
          fill="none"
          stroke="var(--brand-ink)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <text x="182" y="60" className="cap" fill="rgb(var(--ink-2))">premium kept</text>
        {/* Above the sloping leg, where the panel is empty. Under it there is a
            sliver of space and the label sat on the line itself. */}
        <text x="46" y="46" className="cap" fill="rgb(var(--ink-2))">below the strike,</text>
        <text x="46" y="58" className="cap" fill="rgb(var(--ink-2))">you buy in</text>
        <text x="176" y="142" className="cap" textAnchor="middle" fill="rgb(var(--ink-faint))">strike</text>
        <text x="302" y="142" className="cap" textAnchor="end" fill="rgb(var(--ink-faint))">price at expiry</text>

        <style jsx>{`
          .cap {
            font-family: var(--font-mono);
            font-size: 9px;
            letter-spacing: 0.04em;
          }
          /* Drawn rather than shown, because the line is read left to right and
             that is also the order the outcomes happen in. */
          .payoff {
            stroke-dasharray: 320;
            stroke-dashoffset: 320;
            animation: draw 1.1s var(--ease-entrance) forwards;
          }
          @keyframes draw {
            to { stroke-dashoffset: 0; }
          }
        `}</style>
      </svg>

      <p className="font-mono text-caption text-ink-2 mt-3">
        You name a price you would be happy to buy at and are paid for the promise, in{' '}
        {LUSD_CODE}, at the moment you make it. Above that price at expiry the premium is the
        whole trade. Below it, the cash you escrowed buys the asset at the price you named.
      </p>
    </div>
  )
}
