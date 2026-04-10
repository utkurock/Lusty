'use client'
import { useEffect, useRef, useState } from 'react'

interface PriceData {
  price: number
  change24h: number
  loading: boolean
  error: string | null
  source: 'binance-ws' | 'binance-rest' | 'fallback'
}

const SYMBOL = 'xlmusdt'
const WS_URL = `wss://stream.binance.com:9443/stream?streams=${SYMBOL}@trade/${SYMBOL}@ticker`
const REST_URL = `https://api.binance.com/api/v3/ticker/24hr?symbol=XLMUSDT`

export function useXlmPrice(): PriceData {
  const [data, setData] = useState<PriceData>({
    price: 0.10,
    change24h: 0,
    loading: true,
    error: null,
    source: 'fallback',
  })

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

    // Seed price from REST so the UI has a number before the first WS tick.
    const seed = async () => {
      try {
        const res = await fetch(REST_URL)
        const json = await res.json()
        if (cancelled) return
        setData((prev) => ({
          ...prev,
          price: parseFloat(json.lastPrice) || prev.price,
          change24h: parseFloat(json.priceChangePercent) || 0,
          loading: false,
          error: null,
          source: 'binance-rest',
        }))
      } catch {
        if (!cancelled) {
          setData((prev) => ({ ...prev, loading: false }))
        }
      }
    }

    const connect = () => {
      if (cancelled) return
      try {
        const ws = new WebSocket(WS_URL)
        wsRef.current = ws

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            const stream: string = msg.stream
            const payload = msg.data
            if (!payload) return

            if (stream.endsWith('@trade')) {
              const price = parseFloat(payload.p)
              if (!isNaN(price)) {
                setData((prev) => ({
                  ...prev,
                  price,
                  loading: false,
                  error: null,
                  source: 'binance-ws',
                }))
              }
            } else if (stream.endsWith('@ticker')) {
              const change = parseFloat(payload.P)
              const last = parseFloat(payload.c)
              if (!isNaN(change)) {
                setData((prev) => ({
                  ...prev,
                  price: !isNaN(last) ? last : prev.price,
                  change24h: change,
                  loading: false,
                  error: null,
                  source: 'binance-ws',
                }))
              }
            }
          } catch {
            /* ignore parse errors */
          }
        }

        ws.onerror = () => {
          setData((prev) => ({ ...prev, error: 'ws-error' }))
        }

        ws.onclose = () => {
          if (cancelled) return
          reconnectRef.current = window.setTimeout(connect, 3000)
        }
      } catch {
        reconnectRef.current = window.setTimeout(connect, 3000)
      }
    }

    seed()
    connect()

    return () => {
      cancelled = true
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
      }
    }
  }, [])

  return data
}
