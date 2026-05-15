/** Bengali Taka — Unicode U+09F3 (৳). Never use HTML entities, emoji, or legacy encodings. */
export const BDT_SYMBOL = '\u09F3'

/** UI stack — Inter for Latin; Bengali fonts resolve ৳ before Inter fallback. */
export const FONT_STACK_UI =
  "'Inter', 'Noto Sans Bengali', 'Hind Siliguri', system-ui, sans-serif"

/** Bengali-first stack for money (symbol + digits). */
export const FONT_STACK_CURRENCY =
  "var(--font-bengali), var(--font-hind), 'Noto Sans Bengali', 'Hind Siliguri', var(--font-inter), Inter, system-ui, sans-serif"

/** @react-pdf/renderer registered family (see lib/pdf/fonts.ts). */
export const FONT_STACK_PDF = 'AlmaPDF'

/** Tailwind / JSX class for any BDT amount. */
export const MONEY_CLASS = 'currency tabular-nums'

/** Recharts SVG ticks — explicit names (CSS vars unreliable in SVG). */
export const CHART_FONT_FAMILY =
  "'Noto Sans Bengali', 'Hind Siliguri', Inter, system-ui, sans-serif"

const BD_NUMBER_FMT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
}

/** Bangladesh / Indian grouping: ৳67,900 · ৳5,02,609 */
export function formatBDT(amount: number, options?: { decimals?: number }): string {
  const n = Number(amount) || 0
  const decimals = options?.decimals ?? 0
  const formatted = n.toLocaleString('en-IN', {
    ...BD_NUMBER_FMT,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${BDT_SYMBOL}${formatted}`
}

export const fmt = formatBDT

export function fmtNum(n: number, decimals = 0): string {
  return (Number(n) || 0).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/** Chart axis shorthand e.g. ৳12k */
export function formatBDTk(value: number): string {
  const v = Number(value) || 0
  if (Math.abs(v) >= 1000) return `${BDT_SYMBOL}${(v / 1000).toFixed(0)}k`
  return formatBDT(v)
}

/** Split a formatBDT() string into symbol + number (for React rendering). */
export function splitBDT(formatted: string): { symbol: string; amount: string } | null {
  if (!formatted.startsWith(BDT_SYMBOL)) return null
  return { symbol: BDT_SYMBOL, amount: formatted.slice(BDT_SYMBOL.length) }
}
