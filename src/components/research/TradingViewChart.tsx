'use client'
import { useEffect, useRef } from 'react'

// Lightweight TradingView embed. We inject the official tv.js script once
// per page and spawn an advanced chart widget pointing at XLM/USDT on
// Binance. Styled to blend with the cream theme.
export function TradingViewChart({
  symbol = 'BINANCE:XLMUSDT',
  interval = '60',
  height = 420,
}: {
  symbol?: string
  interval?: string
  height?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    // Clear old widget if re-mounting
    containerRef.current.innerHTML = ''

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/tv.js'
    script.async = true
    script.onload = () => {
      // @ts-expect-error – TradingView is injected globally
      if (typeof window.TradingView === 'undefined') return
      // @ts-expect-error –
      new window.TradingView.widget({
        autosize: true,
        symbol,
        interval,
        timezone: 'Etc/UTC',
        theme: 'light',
        style: '1',
        locale: 'en',
        enable_publishing: false,
        hide_top_toolbar: true,
        hide_legend: false,
        save_image: false,
        allow_symbol_change: true,
        calendar: false,
        backgroundColor: '#f0ece3',
        gridColor: 'rgba(196, 191, 178, 0.5)',
        container_id: containerRef.current!.id,
        studies: ['MASimple@tv-basicstudies'],
      })
    }
    containerRef.current.appendChild(script)

    return () => {
      if (containerRef.current) containerRef.current.innerHTML = ''
    }
  }, [symbol, interval])

  return (
    <div
      id="lusty_tv_chart"
      ref={containerRef}
      className="w-full light-card rounded-sm overflow-hidden"
      style={{ height }}
    />
  )
}
