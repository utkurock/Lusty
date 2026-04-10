# Lusty

DeFi options yield protocol on Stellar. Sell covered calls and cash-secured puts, receive upfront yield instantly.

**Network:** Stellar Testnet

**Live:** [lusty.finance](https://lusty.finance)

---

## What is Lusty?

Lusty lets you earn yield by selling options on XLM. You pick a strike price, deposit collateral, and receive LUSD upfront immediately. At expiry, you either get your collateral back or get assigned at the strike you chose — either way, the upfront is yours to keep.

- **Covered calls** — deposit XLM, earn LUSD upfront for selling upside
- **Cash-secured puts** — deposit LUSD, earn LUSD upfront for bidding XLM at a discount
- **Swap** — exchange XLM and LUSD at live Binance spot with 0.1% spread
- **Leaderboard** — Season 0 points for deposits, upfront earned, and swap volume

## How it works

```
User deposits XLM or LUSD → Distributor wallet
                                 ↓
                    Black-Scholes pricing engine
                         ↓              ↓
                   85% upfront      15% protocol fee
                      to user        to fee wallet

At expiry:
  spot inside strike → collateral returned
  spot outside strike → assigned at strike price
```

## Architecture

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS |
| Wallet | Stellar Wallets Kit (Freighter, xBull, Albedo, Lobstr) |
| Settlement | Stellar Classic payments via distributor account |
| Pricing | Black-Scholes with volatility smile + dynamic APR |
| Price feed | Binance REST API (server-side) + WebSocket (client) |
| Database | PostgreSQL (Supabase) |
| AI research | Gemini 2.0 Flash — hourly desk notes |

## Testnet addresses

```
LUSD issuer        GBCMRD6NDL2RAJUOFQ25EHZVO3IRIGNESWE4QDRFB4AVFIP7IT5BRCJ6
LUSD distributor   GBAIN6CHZJGBL365JNXSRQEKALXYTWKXANQZ3RBM7AGUEYYKLJJ6SNR6
USDC (SAC)         CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
```

**LUSD** is a testnet stablecoin (pegged 1:1 to USD) minted by the Lusty protocol. It is used for upfront payments, put vault collateral, and swap liquidity.

## Pricing model

```
iv_eff      = base_iv * (1 + 6.0 * ln(K/S)^2)           // volatility smile
gross       = BlackScholes(side, spot, strike, time, iv)  // per unit
net_upfront = gross * 0.85                                // 15% protocol fee
APR         = (net_upfront / spot) * (365 / days) * 100
```

Dynamic APR adjustment:
```
timeFactor = min(1, days / 14)
utilFactor = 1 + (0.5 - utilization) * 0.6
finalAPR   = baseAPR * timeFactor * utilFactor
```

## Points (Season 0)

```
points = deposit_usd * 1 + upfront_lusd * 3 + swap_volume_usd * 0.5
```

## Project structure

```
src/
  app/
    (app)/dashboard/     Dashboard — view & claim positions
    (app)/research/      Research desk — TradingView chart, AI notes, news
    earn/                Earn page — select strike, deposit, receive upfront
    leaderboard/         Season 0 leaderboard
    swap/                XLM <> LUSD swap
    docs/                Documentation
    api/
      vault/deposit/     Verify deposit tx, pay upfront + fee
      vault/claim/       Settle expired positions
      vault/stats/       Vault utilization stats
      swap/              Server-side swap execution
      faucet/lusd/       Testnet LUSD faucet
      leaderboard/       Leaderboard data
      admin/             Admin panel API (wallet-signature auth)
      research/          AI commentary + news aggregation
  lib/
    pricing.ts           Black-Scholes engine + volatility smile
    db.ts                PostgreSQL pool + schema
    rate-limit.ts        In-memory sliding-window rate limiter
    admin-auth.ts        Session token validation
    admin-sessions.ts    Challenge-response auth with wallet signatures
  components/
    earn/                Strike selector, position summary, earn button
    admin/               Admin overlay (hidden, wallet-gated)
    research/            TradingView chart
```

## Security

- All secrets in `.env.local` (gitignored)
- Admin auth via Stellar wallet signature (challenge-response)
- Rate limiting on all endpoints
- Input validation with centralized Stellar address checker
- CSP, HSTS, X-Frame-Options security headers
- Parameterized SQL queries (no injection)
- No fallback price — transactions rejected if Binance feed is down

## License

MIT
