import type { Config } from 'tailwindcss'

/**
 * Colours are CSS-variable backed so the cream (light) and warm-black (dark)
 * themes can be swapped by toggling the `dark` class on <html>. Variables hold
 * space-separated RGB channels so Tailwind's `/opacity` modifier keeps working
 * (e.g. `bg-surface/50`). Accent colours are intentionally theme-independent.
 *
 * The scales below are the same tokens `globals.css` declares, re-exposed as
 * utilities. Radius, shadow and easing are deliberately *redefined* rather than
 * extended: `rounded-sm` is the app's default corner in a hundred places, and
 * the system it belongs to now says that corner is 8px, so the name keeps
 * meaning "the default corner" instead of becoming a lie about 2px.
 */
const tokenColors = {
  surface: 'rgb(var(--surface) / <alpha-value>)',
  'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
  card: 'rgb(var(--card) / <alpha-value>)',
  raised: 'rgb(var(--raised) / <alpha-value>)',
  inverse: 'rgb(var(--inverse) / <alpha-value>)',
  ink: 'rgb(var(--ink) / <alpha-value>)',
  'ink-2': 'rgb(var(--ink-2) / <alpha-value>)',
  'ink-3': 'rgb(var(--ink-3) / <alpha-value>)',
  'ink-faint': 'rgb(var(--ink-faint) / <alpha-value>)',
  cream: 'rgb(var(--cream) / <alpha-value>)',
  line: 'rgb(var(--line) / <alpha-value>)',
  'line-light': 'rgb(var(--line-light) / <alpha-value>)',
  'line-2': 'rgb(var(--line-2) / <alpha-value>)',
  'line-interactive': 'rgb(var(--line-interactive) / <alpha-value>)',
}

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ...tokenColors,
        brand: 'var(--brand)',
        'accent-green': '#22c55e',
        'accent-red': '#ef4444',
        'accent-yellow': '#eab308',
      },
      /* One face across the interface. `mono` is kept as a name because 239
         call sites use it, but it now resolves to Jeko like everything else;
         `code` is the only real monospace left, for code and hashes. */
      fontFamily: {
        display: ['Jeko', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['Jeko', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Jeko', 'Inter', 'system-ui', 'sans-serif'],
        code: ['JetBrains Mono', 'Courier New', 'monospace'],
      },
      /* A small scale, tightly tracked. Sizes below 16px get negative tracking
         so they set as densely as the numerals beside them; the display sizes
         get more of it, because Jeko is already drawn tight. */
      fontSize: {
        micro: ['10px', { lineHeight: '14px', letterSpacing: '-0.01em' }],
        tiny: ['11px', { lineHeight: '16px', letterSpacing: '-0.01em' }],
        caption: ['12px', { lineHeight: '16px', letterSpacing: '-0.011em' }],
        body: ['14px', { lineHeight: '20px', letterSpacing: '-0.016em' }],
        lead: ['16px', { lineHeight: '24px', letterSpacing: '-0.016em' }],
        'head-sm': ['20px', { lineHeight: '24px', letterSpacing: '-0.02em' }],
        'head-md': ['24px', { lineHeight: '32px', letterSpacing: '-0.02em' }],
        'head-lg': ['36px', { lineHeight: '40px', letterSpacing: '-0.022em' }],
        hero: ['48px', { lineHeight: '52px', letterSpacing: '-0.025em' }],
        'hero-lg': ['64px', { lineHeight: '66px', letterSpacing: '-0.028em' }],
      },
      borderRadius: {
        none: '0',
        sm: 'var(--r)',        /* the default corner — 8px */
        DEFAULT: 'var(--r)',
        md: '10px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
        compact: 'var(--r-compact)',
        inner: 'var(--r-inner)',
        full: '9999px',
      },
      boxShadow: {
        drop: 'var(--shadow-drop)',
        menu: 'var(--shadow-menu)',
        table: 'var(--shadow-table)',
        button: 'var(--shadow-button)',
        /* Tailwind's greys are wrong in both themes; the aliases keep existing
           `shadow-md` / `shadow-lg` usage on the token system. */
        sm: 'var(--shadow-button)',
        DEFAULT: 'var(--shadow-button)',
        md: 'var(--shadow-drop)',
        lg: 'var(--shadow-drop)',
        xl: 'var(--shadow-menu)',
        '2xl': 'var(--shadow-menu)',
        none: 'none',
      },
      transitionTimingFunction: {
        std: 'var(--ease-std)',
        entrance: 'var(--ease-entrance)',
      },
      transitionDuration: {
        press: '100ms',
        fast: '150ms',
        std: '200ms',
      },
      spacing: {
        nav: 'var(--nav-h)',
        row: 'var(--row-h)',
      },
      maxWidth: {
        content: '1200px',
      },
    },
  },
  plugins: [],
}

export default config
