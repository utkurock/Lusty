import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        'bg-primary': '#e8e4d9',
        'bg-secondary': '#d4cfc2',
        'bg-card': '#1a1a1a',
        'bg-card-inner': '#f0ece3',
        'text-primary': '#1a1a1a',
        'text-secondary': '#6b6560',
        'text-on-dark': '#e8e4d9',
        'accent-green': '#22c55e',
        'accent-red': '#ef4444',
        'accent-yellow': '#eab308',
        'border-light': '#c4bfb2',
        'border-dark': '#2a2a2a',
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
