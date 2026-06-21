import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { prisma } from '@/lib/prisma'

/** Owner-confirmed founding year — printed on every post. */
export const BRAND = {
  name: 'ALMA',
  est: 'EST. 2019 · DHAKA',
  colors: {
    cream: '#F5EBDD',
    charcoal: '#2A2622',
    mustard: '#C89B3C',
    maroon: '#6B2737',
    emerald: '#2D5F4F',
    terracotta: '#C97D5D',
  },
  fonts: {
    bengaliSerif: 'Noto Serif Bengali',
    bengaliBody: 'Hind Siliguri',
    display: 'Playfair Display',
  },
  logoPath: 'assets/brand/alma-logo.png',
  logoTransparentPath: 'assets/brand/alma-logo-transparent.png',
  footer: { page: 'ALMA Lifestyle', contact: '', delivery: '' },
} as const

export const THEME_ACCENT = {
  default: { accent: BRAND.colors.mustard, eyebrow: 'নতুন এসেছে' },
  eid: { accent: BRAND.colors.maroon, eyebrow: 'ঈদ স্পেশাল' },
  puja: { accent: BRAND.colors.terracotta, eyebrow: 'উৎসব কালেকশন' },
  boishakh: { accent: BRAND.colors.emerald, eyebrow: 'বৈশাখী কালেকশন' },
  winter: { accent: BRAND.colors.emerald, eyebrow: 'শীত কালেকশন' },
} as const

export type BrandTheme = keyof typeof THEME_ACCENT

const FONT_DIR = join(process.cwd(), 'public/fonts/brand')
const FALLBACK_FONT_DIR = join(process.cwd(), 'public/fonts')

let fontDataCache: Record<string, string | null> | null = null

function toDataUri(buf: Buffer): string {
  return `data:font/ttf;base64,${buf.toString('base64')}`
}

function readFontFile(filename: string): string | null {
  const brandPath = join(FONT_DIR, filename)
  if (existsSync(brandPath)) return toDataUri(readFileSync(brandPath))
  const fallbackMap: Record<string, string> = {
    'NotoSerifBengali-Regular.ttf': 'NotoSansBengali-Regular.ttf',
    'NotoSerifBengali-Bold.ttf': 'NotoSansBengali-Bold.ttf',
  }
  const fb = fallbackMap[filename]
  if (fb) {
    const p = join(FALLBACK_FONT_DIR, fb)
    if (existsSync(p)) return toDataUri(readFileSync(p))
  }
  return null
}

/** Embedded @font-face block for SVG text rendering (server-side sharp). */
export function buildBrandFontFaces(): string {
  if (!fontDataCache) {
    fontDataCache = {
      serif: readFontFile('NotoSerifBengali-Regular.ttf'),
      serifBold: readFontFile('NotoSerifBengali-Bold.ttf'),
      body: readFontFile('HindSiliguri-Regular.ttf'),
      display: readFontFile('PlayfairDisplay-Regular.ttf'),
    }
  }
  const { serif, serifBold, body, display } = fontDataCache
  const faces: string[] = []
  if (serif) {
    faces.push(`@font-face{font-family:'AlmaSerif';src:url('${serif}') format('truetype');font-weight:400;font-style:normal;}`)
  }
  if (serifBold) {
    faces.push(`@font-face{font-family:'AlmaSerif';src:url('${serifBold}') format('truetype');font-weight:700;font-style:normal;}`)
  }
  if (body) {
    faces.push(`@font-face{font-family:'AlmaBody';src:url('${body}') format('truetype');font-weight:400;font-style:normal;}`)
  }
  if (display) {
    faces.push(`@font-face{font-family:'AlmaDisplay';src:url('${display}') format('truetype');font-weight:400;font-style:normal;}`)
  }
  if (!faces.length) return ''
  return `<style>${faces.join('')}</style>`
}

export const BRAND_FONT = {
  serif: 'AlmaSerif, Noto Serif Bengali, serif',
  body: 'AlmaBody, Hind Siliguri, sans-serif',
  display: 'AlmaDisplay, Playfair Display, serif',
} as const

/**
 * Make the bundled brand fonts discoverable by **fontconfig** before any sharp/
 * librsvg text render.
 *
 * Why this is required: sharp's librsvg IGNORES embedded `@font-face` data URIs —
 * it only renders text with fonts that fontconfig can find on disk. On a dev Mac
 * the OS happens to ship Bangla fonts (so text "just works" locally), but on
 * Vercel/Lambda there are NO system fonts at all → every glyph renders blank, and
 * on a bare Linux box Bangla becomes tofu boxes. We point fontconfig at our
 * bundled `public/fonts/**` (the .ttf are traced into the serverless function) and
 * give it a writable cache dir under /tmp (Lambda's only writable path). Because
 * BRAND_FONT already lists the real family names ("Noto Serif Bengali" …) as
 * fallbacks, registering the dir is enough — no SVG changes needed.
 *
 * Idempotent + best-effort: runs once per process, never throws.
 */
let fontConfigReady = false
export function ensureBrandFonts(): void {
  if (fontConfigReady) return
  fontConfigReady = true
  try {
    const dirs = [
      join(process.cwd(), 'public/fonts/brand'),
      join(process.cwd(), 'public/fonts'),
    ].filter((d) => existsSync(d))
    if (!dirs.length) return
    const cacheDir = join(tmpdir(), 'alma-fontconfig')
    mkdirSync(cacheDir, { recursive: true })
    const confPath = join(tmpdir(), 'alma-fonts.conf')
    // No DOCTYPE on purpose — Lambda has no fonts.dtd and fontconfig parses fine
    // without it (a missing DTD otherwise spams stderr / can fail).
    const conf =
      `<?xml version="1.0"?>\n<fontconfig>\n`
      + dirs.map((d) => `  <dir>${d}</dir>`).join('\n')
      + `\n  <cachedir>${cacheDir}</cachedir>\n</fontconfig>\n`
    writeFileSync(confPath, conf)
    // librsvg/pango read these env vars when fontconfig first initialises.
    process.env.FONTCONFIG_FILE = confPath
    process.env.FONTCONFIG_PATH = tmpdir()
    if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = tmpdir()
  } catch (err) {
    console.warn('[brand-fonts] fontconfig setup failed:', err instanceof Error ? err.message : err)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Resolve logo path from saved BrandAsset or static default. Never throws — a DB
 * hiccup (or a not-yet-migrated table) falls back to the static default path so the
 * caller can still proceed (e.g. the logo upload route writes to the default path). */
export async function getLogoPath(transparent = false): Promise<string> {
  const fallback = transparent ? BRAND.logoTransparentPath : BRAND.logoPath
  try {
    const kind = transparent ? 'logo_transparent' : 'logo'
    const row = await db.brandAsset.findUnique({ where: { kind } })
    return row?.path ?? fallback
  } catch (err) {
    console.warn('[brand] getLogoPath failed, using default:', err instanceof Error ? err.message : err)
    return fallback
  }
}
