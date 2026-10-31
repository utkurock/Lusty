const FAQ = [
  {
    q: 'What is Lusty?',
    a: 'An options yield venue on Stellar. You sell a covered call on the asset you hold, or a cash-secured put with dollars, and receive the premium the moment you deposit.',
  },
  {
    q: 'Who holds my collateral?',
    a: 'The vault contract. It escrows collateral and pays the premium in one atomic transaction, and releases it only through settlement at expiry.',
  },
  {
    q: 'What happens at expiry?',
    a: 'For a covered call, spot at or below your strike returns your collateral whole; above it, you receive the strike value in cash. Puts mirror this. The premium is yours in every case.',
  },
  {
    q: 'What does it cost?',
    a: 'A 10% fee on the upfront, taken out of the premium before it is paid. Your collateral is never charged.',
  },
  {
    q: 'Is it on mainnet?',
    a: 'Not yet. Lusty runs on Stellar testnet with faucet tokens while an independent audit is completed. Mainnet settles in native USDC.',
  },
]

/** The landing page's questions: a big title on the left, numbered rows that open on the right. */
export function Faq() {
  return (
    <section>
      <div className="mx-auto grid max-w-[1440px] gap-10 px-6 py-16 sm:px-10 md:py-24 lg:grid-cols-[1fr_1.4fr]">
        <h2 className="font-display text-head-lg leading-tight tracking-[-0.03em] text-ink sm:text-hero">
          Frequently<br />asked<br />questions
        </h2>
        <div className="border-t border-line-light">
          {FAQ.map((f, i) => (
            <details key={f.q} className="group border-b border-line-light" open={i === 0}>
              <summary className="flex cursor-pointer list-none items-center gap-6 py-5 [&::-webkit-details-marker]:hidden">
                <span className="num w-6 text-caption text-ink-faint">{String(i + 1).padStart(2, '0')}</span>
                <span className="flex-1 text-lead text-ink">{f.q}</span>
                <span aria-hidden className="text-head-sm text-ink-2 transition-transform duration-std group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="pb-6 pl-12 pr-8 text-body text-ink-2">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
