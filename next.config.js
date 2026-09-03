/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Runs src/instrumentation.ts once per server process. The settlement sweep
  // starts there: it must run whether or not anyone visits the site.
  experimental: {
    instrumentationHook: true,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://s3.tradingview.com https://*.tradingview.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https:",
              "font-src 'self' https://fonts.gstatic.com",
              // Binance is gone from this list on purpose: the browser no longer talks
              // to it. Price now comes from /api/price/xlm, which resolves through
              // Reflector first — so a network that blocks Binance no longer leaves
              // the page without a price.
              "connect-src 'self' https://horizon-testnet.stellar.org https://soroban-testnet.stellar.org https://friendbot.stellar.org https://*.supabase.co https://*.supabase.com wss://*.stellar.org https://*.tradingview.com https://news.google.com",
              "frame-src https://*.tradingview.com",
              "frame-ancestors 'none'",
            ].join('; '),
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
      // Cross-origin access to the API, only where a deployment asks for it.
      //
      // This block used to fall back to a hard-coded `https://riskstellar.com`
      // — a domain from another project — whenever CORS_ORIGIN was unset. That
      // is not a default, it is a grant: it told every browser that scripts on
      // that origin may read the responses of this API, including the admin
      // routes named in the allowed headers. Nothing here needs it either way,
      // because the frontend is served from the same origin as the API, and a
      // same-origin request never consults these headers.
      //
      // So there is no fallback. Set CORS_ORIGIN only if something outside this
      // domain genuinely has to read the API.
      ...(process.env.CORS_ORIGIN
        ? [
            {
              source: '/api/:path*',
              headers: [
                { key: 'Access-Control-Allow-Origin', value: process.env.CORS_ORIGIN },
                { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
                { key: 'Access-Control-Allow-Headers', value: 'Content-Type, x-admin-token' },
                { key: 'Vary', value: 'Origin' },
              ],
            },
          ]
        : []),
    ]
  },
}

module.exports = nextConfig
