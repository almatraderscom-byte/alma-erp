'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  ACCENTS,
  ACCENT_COOKIE,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  accentStyle,
  type AccentKey,
  type ThemeMode,
} from '@/lib/theme'

type ThemeContextValue = {
  mode: ThemeMode
  accent: AccentKey
  setMode: (mode: ThemeMode) => void
  toggleMode: () => void
  setAccent: (accent: AccentKey) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`
}

/** Imperatively reflect theme onto <html> so the change is instant, no re-render race. */
function applyToDocument(mode: ThemeMode, accent: AccentKey) {
  const root = document.documentElement
  root.dataset.theme = mode
  const overrides = accentStyle(accent)
  // Clear any previous accent override, then set the active one.
  root.style.removeProperty('--c-accent')
  root.style.removeProperty('--c-accent-lt')
  root.style.removeProperty('--c-accent-dim')
  for (const [key, val] of Object.entries(overrides)) {
    root.style.setProperty(key, val)
  }
}

export function ThemeProvider({
  initialMode,
  initialAccent,
  children,
}: {
  initialMode: ThemeMode
  initialAccent: AccentKey
  children: ReactNode
}) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode)
  const [accent, setAccentState] = useState<AccentKey>(initialAccent)

  // Mirror latest values so the stable callbacks read fresh state without churn.
  const modeRef = useLatest(mode)
  const accentRef = useLatest(accent)

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    applyToDocument(next, accentRef.current)
    writeCookie(THEME_COOKIE, next)
  }, [accentRef])

  const setAccent = useCallback((next: AccentKey) => {
    if (!ACCENTS[next]) return
    setAccentState(next)
    applyToDocument(modeRef.current, next)
    writeCookie(ACCENT_COOKIE, next)
  }, [modeRef])

  const toggleMode = useCallback(() => {
    setMode(modeRef.current === 'dark' ? 'light' : 'dark')
  }, [setMode, modeRef])

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, accent, setMode, toggleMode, setAccent }),
    [mode, accent, setMode, toggleMode, setAccent],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>')
  return ctx
}

/** Tiny ref-mirror so stable callbacks read fresh state without dependency churn. */
function useLatest<T>(value: T) {
  const [ref] = useState(() => ({ current: value }))
  ref.current = value
  return ref
}
