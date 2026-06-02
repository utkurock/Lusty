import type { Config } from 'tailwindcss'

/**
 * Colours are CSS-variable backed so the cream (light) and warm-black (dark)
 * themes can be swapped by toggling the `dark` class on <html>. Variables hold
 * space-separated RGB channels so Tailwind's `/opacity` modifier keeps working
 * (e.g. `bg-surface/50`). Accent colours are intentionally theme-independent.
 */
const tokenColors = {
  surface: 'rgb(var(--surface) / <alpha-value>)',
  'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
  card: 'rgb(var(--card) / <alpha-value>)',
  inverse: 'rgb(var(--inverse) / <alpha-value>)',
  ink: 'rgb(var(--ink) / <alpha-value>)',
  'ink-2': 'rgb(var(--ink-2) / <alpha-value>)',
  'ink-3': 'rgb(var(--ink-3) / <alpha-value>)',
  cream: 'rgb(var(--cream) / <alpha-value>)',
  line: 'rgb(var(--line) / <alpha-value>)',
  'line-2': 'rgb(var(--line-2) / <alpha-value>)',
}

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ...tokenColors,
        'accent-green': '#22c55e',
        'accent-red': '#ef4444',
        'accent-yellow': '#eab308',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Courier New', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

export default config
