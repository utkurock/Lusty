'use client'

import { Fragment } from 'react'
import { Banknote, Landmark, Repeat, TrendingUp, Wallet } from 'lucide-react'
import { ANCHOR_ASSET_CODE, FIAT_CODE } from '@/lib/anchor/config'
import { LUSD_CODE } from '@/lib/lusd'

/**
 * The whole journey, as five stops.
 *
 * Every screen in this section explains its own step, and nowhere said what
 * the steps add up to. The motion is the point: a still diagram of five boxes
 * reads as five features, and this is one path with a direction.
 *
 * So there is one pulse, not four. It leaves a stop, crosses to the next, and
 * the stop it is at wears the same brand ring a selected strike does on the
 * ladder — the money is somewhere specific at every moment, and that is the
 * thing worth showing. The app's reduced-motion rule stops all of it for
 * anyone who asked for that.
 */

/**
 * One leg's travel, and the whole loop including the beat of darkness before
 * it starts over. The keyframes below are written as percentages of TOTAL_MS
 * (a leg is 18% of it), so these two numbers and those percentages have to
 * move together.
 */
const LEG_MS = 1800
const TOTAL_MS = 10000

const STATIONS = [
  { icon: Banknote, title: FIAT_CODE, note: 'bank transfer' },
  { icon: Landmark, title: 'anchor', note: 'SEP-6 deposit' },
  { icon: Wallet, title: ANCHOR_ASSET_CODE, note: 'in your wallet' },
  { icon: Repeat, title: LUSD_CODE, note: 'one for one' },
  { icon: TrendingUp, title: 'position', note: 'premium upfront' },
]

export function RoundTripDiagram() {
  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-stretch gap-2">
        {STATIONS.map((station, i) => (
          <Fragment key={station.title}>
            <div
              className="station raised-card p-4 flex-1 flex md:block items-center gap-3"
              style={{ animationDelay: `${i * LEG_MS}ms`, animationDuration: `${TOTAL_MS}ms` }}
            >
              <station.icon size={16} className="text-brand shrink-0" />
              <div className="md:mt-2">
                <div className="font-mono text-body text-ink">{station.title}</div>
                <div className="font-mono text-caption text-ink-2">{station.note}</div>
              </div>
            </div>

            {i < STATIONS.length - 1 && (
              <div className="conn" aria-hidden>
                <span
                  className="dot"
                  style={{ animationDelay: `${i * LEG_MS}ms`, animationDuration: `${TOTAL_MS}ms` }}
                />
              </div>
            )}
          </Fragment>
        ))}
      </div>

      <p className="font-mono text-caption text-ink-2 mt-4">
        And the same line read backwards: a premium in {LUSD_CODE}, crossed back to{' '}
        {ANCHOR_ASSET_CODE}, withdrawn as {FIAT_CODE} to an IBAN.
      </p>

      <style jsx>{`
        /* The stop the money is at, wearing the ladder's selected ring: a brand
           hairline, a wash of the same colour laid in with an inset shadow so
           the card keeps its own surface, and no change of size. It fades out
           over the next leg rather than snapping, which leaves a short trail
           behind the pulse. */
        .station {
          animation: lightUp 10000ms linear infinite;
        }
        @keyframes lightUp {
          0% {
            border-color: var(--brand);
            box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--brand) 10%, transparent),
              0 0 0 1px var(--brand);
          }
          18% {
            border-color: var(--brand);
            box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--brand) 10%, transparent),
              0 0 0 1px var(--brand);
          }
          28% {
            border-color: transparent;
            box-shadow: inset 0 0 0 999px transparent, var(--shadow-menu);
          }
          100% {
            border-color: transparent;
            box-shadow: inset 0 0 0 999px transparent, var(--shadow-menu);
          }
        }

        /* The connector is a rule with one thing moving along it. Vertical while
           the stations are stacked, horizontal once they sit in a row. */
        .conn {
          position: relative;
          align-self: center;
          width: 1px;
          height: 24px;
          background: rgb(var(--line));
        }
        .dot {
          position: absolute;
          left: -2px;
          width: 5px;
          height: 5px;
          border-radius: 9999px;
          background: var(--brand);
          /* 1800ms of travel inside a 10s cycle is 18% of it. The rest of the
             cycle the dot is parked at the far end, invisible, waiting for its
             turn to come round. */
          animation: flowDown 10000ms linear infinite;
        }
        @keyframes flowDown {
          0% { top: 0; opacity: 0; }
          1% { top: 0; opacity: 1; }
          17% { opacity: 1; }
          18% { top: 100%; opacity: 0; }
          100% { top: 100%; opacity: 0; }
        }
        @media (min-width: 768px) {
          .conn {
            width: 32px;
            height: 1px;
            margin: 0 2px;
          }
          .dot {
            left: 0;
            top: -2px;
            animation-name: flowRight;
          }
          @keyframes flowRight {
            0% { left: 0; opacity: 0; }
            1% { left: 0; opacity: 1; }
            17% { opacity: 1; }
            18% { left: 100%; opacity: 0; }
            100% { left: 100%; opacity: 0; }
          }
        }
      `}</style>
    </div>
  )
}
