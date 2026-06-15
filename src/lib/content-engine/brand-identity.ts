import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Resolve logo path from saved BrandAsset or static default. */
export async function getLogoPath(transparent = false): Promise<string> {
  const kind = transparent ? 'logo_transparent' : 'logo'
  const row = await db.brandAsset.findUnique({ where: { kind } })
  return row?.path ?? (transparent ? BRAND.logoTransparentPath : BRAND.logoPath)
}
