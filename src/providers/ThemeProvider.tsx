'use client'
import { createContext, useContext, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'lusty-theme'

const ThemeContext = createContext<{
  theme: Theme
  toggle: () => void
  setTheme: (t: Theme) => void
}>({ theme: 'light', toggle: () => {}, setTheme: () => {} })

// Cream is the default; dark is opt-in and persisted to localStorage. The class
// on <html> drives the CSS-variable swap defined in globals.css. An inline
// script in the document head applies the stored choice before paint to avoid a
// flash; this provider keeps React state in sync afterwards.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light')

  useEffect(() => {
    let initial: Theme = 'light'
    try {
      if (localStorage.getItem(STORAGE_KEY) === 'dark') initial = 'dark'
    } catch {}
    setThemeState(initial)
    document.documentElement.classList.toggle('dark', initial === 'dark')
  }, [])

  const setTheme = (t: Theme) => {
    setThemeState(t)
    document.documentElement.classList.toggle('dark', t === 'dark')
    try {
      localStorage.setItem(STORAGE_KEY, t)
    } catch {}
  }

  const toggle = () => setTheme(theme === 'dark' ? 'light' : 'dark')

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
