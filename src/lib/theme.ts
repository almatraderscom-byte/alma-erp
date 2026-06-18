/**
 * Theme model for the ALMA token system (PART A).
 *
 * One source of truth for color: every surface/border/text reads CSS variables
 * defined in globals.css. This module only decides *which* values those
 * variables hold — the base mode (light/dark) and the accent preset (custom).
 *
 * Persistence is a cookie (not localStorage) so the server can read it during
 * SSR and set <html data-theme> before paint — no flash of the wrong theme.
 */

export type ThemeMode = 'light' | 'dark'
export type AccentKey = 'coral' | 'blue' | 'green' | 'violet' | 'amber'

export const THEME_COOKIE = 'alma-theme'
export const ACCENT_COOKIE = 'alma-accent'
export const DEFAULT_MODE: ThemeMode = 'light'
export const DEFAULT_ACCENT: AccentKey = 'coral'

/** One year, app-wide, survives refreshes. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * Accent presets. Each value is a space-separated RGB channel triplet so it can
 * slot straight into `rgb(var(--c-accent) / <alpha-value>)`. `coral` is the
 * ALMA brand and matches the :root defaults exactly (no override emitted).
 */
export const ACCENTS: Record<AccentKey, { label: string; accent: string; accentLt: string; accentDim: string }> = {
  coral: { label: 'Coral', accent: '224 122 95', accentLt: '244 162 140', accentDim: '196 90 60' },
  blue: { label: 'Blue', accent: '59 130 246', accentLt: '147 197 253', accentDim: '37 99 235' },
  green: { label: 'Green', accent: '34 167 122', accentLt: '110 211 178', accentDim: '21 128 91' },
  violet: { label: 'Violet', accent: '139 92 246', accentLt: '196 181 253', accentDim: '109 64 217' },
  amber: { label: 'Amber', accent: '217 152 49', accentLt: '244 196 124', accentDim: '180 120 30' },
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark'
}

export function isAccentKey(value: unknown): value is AccentKey {
  return typeof value === 'string' && value in ACCENTS
}

export function normalizeMode(value: unknown): ThemeMode {
  return isThemeMode(value) ? value : DEFAULT_MODE
}

export function normalizeAccent(value: unknown): AccentKey {
  return isAccentKey(value) ? value : DEFAULT_ACCENT
}

/**
 * Inline CSS-variable overrides for a non-default accent, applied to <html> on
 * the server (SSR) and the client. Returns an empty object for the brand accent
 * so the :root defaults win and no style attribute is emitted.
 */
export function accentStyle(accent: AccentKey): Record<string, string> {
  if (accent === DEFAULT_ACCENT) return {}
  const a = ACCENTS[accent]
  return {
    '--c-accent': a.accent,
    '--c-accent-lt': a.accentLt,
    '--c-accent-dim': a.accentDim,
  }
}
