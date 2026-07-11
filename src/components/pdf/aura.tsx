'use client'
/**
 * Aura PDF design system — shared tokens + primitives for every ERP document
 * (invoice, salary slip, payroll reports, expense ledger).
 *
 * Mirrors the app's aura theme: coral accent (#E07A5F), cream/dark canvas,
 * aurora gradient signature, rounded panels, soft tinted washes.
 *
 * react-pdf constraints respected: gradients only inside <Svg>, no blur,
 * fontWeight capped at 700 (registered Noto weights: 400/600/700).
 */
import React from 'react'
import {
  View, Text, Image, Svg, Defs, LinearGradient, RadialGradient, Stop, Rect, Circle,
} from '@react-pdf/renderer'
import { A4_WIDTH_PT, A4_HEIGHT_PT } from '@/lib/pdf/a4'

export type AuraMode = 'light' | 'dark'

export const AURA_ACCENT = '#E07A5F'

/* Aurora signature colors (from the app's ambient background) */
const AURORA_VIOLET = '#7C4DFF'
const AURORA_BLUE = '#3880FF'
const AURORA_PINK = '#FF2E86'

export interface AuraPalette {
  mode: AuraMode
  accent: string
  accentDim: string
  accentLt: string
  bg: string
  panel: string
  panel2: string
  ink: string
  muted: string
  faint: string
  line: string
  lineSoft: string
  accentWash: string
  accentBorder: string
  success: string
  successBg: string
  warning: string
  warningBg: string
  danger: string
  dangerBg: string
  info: string
  infoBg: string
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [224, 122, 95]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * Opaque blend of fg over bg at the given alpha. react-pdf mis-renders
 * alpha (rgba) BORDER colors, so every border color must be a flat hex —
 * backgrounds may keep rgba.
 */
function mixHex(fg: string, bg: string, alpha: number): string {
  const f = hexToRgb(fg)
  const b = hexToRgb(bg)
  const c = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

export function auraPalette(mode: AuraMode, accent: string = AURA_ACCENT): AuraPalette {
  if (mode === 'dark') {
    return {
      mode,
      accent,
      accentDim: '#C45A3C',
      accentLt: '#F4A28C',
      bg: '#141418',
      panel: '#1C1C22',
      panel2: '#232329',
      ink: '#F7F8FC',
      muted: '#AEB2C0',
      faint: '#7C8090',
      line: mixHex('#FFFFFF', '#141418', 0.12),
      lineSoft: mixHex('#FFFFFF', '#141418', 0.07),
      accentWash: withAlpha(accent, 0.14),
      accentBorder: mixHex(accent, '#141418', 0.45),
      success: '#4ADE80',
      successBg: 'rgba(34,197,94,0.16)',
      warning: '#FBBF24',
      warningBg: 'rgba(245,158,11,0.16)',
      danger: '#F87171',
      dangerBg: 'rgba(239,68,68,0.16)',
      info: '#60A5FA',
      infoBg: 'rgba(59,130,246,0.16)',
    }
  }
  return {
    mode,
    accent,
    accentDim: '#C45A3C',
    accentLt: '#F4A28C',
    bg: '#FFFFFF',
    panel: '#FAF9F6',
    panel2: '#F3F2EF',
    ink: '#1A1A2E',
    muted: '#64748B',
    faint: '#94A3B8',
    line: mixHex('#1A1A2E', '#FFFFFF', 0.12),
    lineSoft: mixHex('#1A1A2E', '#FFFFFF', 0.06),
    accentWash: withAlpha(accent, 0.09),
    accentBorder: mixHex(accent, '#FFFFFF', 0.38),
    success: '#16A34A',
    successBg: 'rgba(34,197,94,0.12)',
    warning: '#B45309',
    warningBg: 'rgba(245,158,11,0.14)',
    danger: '#DC2626',
    dangerBg: 'rgba(239,68,68,0.10)',
    info: '#2563EB',
    infoBg: 'rgba(59,130,246,0.10)',
  }
}

/**
 * Full-page aurora backdrop: gradient ribbon along the top edge + soft
 * radial glows in the top corners. Renders on every page (fixed).
 * Place as the FIRST child of <Page> so content stacks above it.
 */
export function AuraBackdrop({ p }: { p: AuraPalette }) {
  const glow = p.mode === 'dark' ? 0.16 : 0.07
  return (
    <View fixed style={{ position: 'absolute', top: 0, left: 0 }}>
      <Svg width={A4_WIDTH_PT} height={A4_HEIGHT_PT}>
        <Defs>
          <LinearGradient id="auraRibbon" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={p.accent} />
            <Stop offset="0.4" stopColor={AURORA_PINK} />
            <Stop offset="0.7" stopColor={AURORA_VIOLET} />
            <Stop offset="1" stopColor={AURORA_BLUE} />
          </LinearGradient>
          <RadialGradient id="auraGlowL" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={p.accent} stopOpacity={glow} />
            <Stop offset="1" stopColor={p.accent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="auraGlowR" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={AURORA_VIOLET} stopOpacity={glow * 0.8} />
            <Stop offset="1" stopColor={AURORA_VIOLET} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={A4_WIDTH_PT} height={4.5} fill="url('#auraRibbon')" />
        <Circle cx={40} cy={30} r={190} fill="url('#auraGlowL')" />
        <Circle cx={A4_WIDTH_PT - 30} cy={20} r={210} fill="url('#auraGlowR')" />
      </Svg>
    </View>
  )
}

/** Short gradient accent bar (decorative underline for headers/sections). */
export function AuraAccentBar({ p, width = 46, height = 2.5 }: { p: AuraPalette; width?: number; height?: number }) {
  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="auraBar" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={p.accent} />
          <Stop offset="1" stopColor={AURORA_VIOLET} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={width} height={height} rx={height / 2} fill="url('#auraBar')" />
    </Svg>
  )
}

export type AuraBadgeTone = 'success' | 'danger' | 'warning' | 'info' | 'accent' | 'neutral'

export function AuraBadge({ p, tone, label }: { p: AuraPalette; tone: AuraBadgeTone; label: string }) {
  const map: Record<AuraBadgeTone, { fg: string; bg: string }> = {
    success: { fg: p.success, bg: p.successBg },
    danger: { fg: p.danger, bg: p.dangerBg },
    warning: { fg: p.warning, bg: p.warningBg },
    info: { fg: p.info, bg: p.infoBg },
    accent: { fg: p.accent, bg: p.accentWash },
    neutral: { fg: p.muted, bg: p.panel2 },
  }
  const t = map[tone]
  return (
    <View style={{
      alignSelf: 'flex-start',
      backgroundColor: t.bg,
      borderRadius: 999,
      paddingVertical: 3,
      paddingHorizontal: 9,
    }}>
      <Text style={{ fontSize: 7, fontWeight: 700, color: t.fg, letterSpacing: 0.8, textTransform: 'uppercase' }}>
        {label}
      </Text>
    </View>
  )
}

/**
 * Document header: logo chip + company identity on the left,
 * document title + meta lines + optional badge on the right.
 */
export function AuraDocHeader({
  p, logoDataUrl, companyName, tagline, docTitle, meta = [], badge,
}: {
  p: AuraPalette
  logoDataUrl?: string | null
  companyName: string
  tagline?: string
  docTitle: string
  meta?: string[]
  badge?: { tone: AuraBadgeTone; label: string }
}) {
  const initials = companyName.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'AL'
  return (
    <View wrap={false} style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '58%' }}>
          <View style={{
            width: 52, height: 40, marginRight: 10, borderRadius: 11,
            borderWidth: 1, borderColor: p.line, backgroundColor: p.panel,
            alignItems: 'center', justifyContent: 'center',
          }}>
            {logoDataUrl
              ? <Image src={logoDataUrl} style={{ width: 44, height: 32, objectFit: 'contain' as const }} />
              : <Text style={{ fontSize: 13, fontWeight: 700, color: p.accent }}>{initials}</Text>}
          </View>
          <View style={{ flexShrink: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: 700, color: p.accent, letterSpacing: 0.2 }}>{companyName}</Text>
            {tagline ? <Text style={{ fontSize: 7, color: p.muted, marginTop: 2 }}>{tagline}</Text> : null}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 19, fontWeight: 700, color: p.ink, letterSpacing: 2.4 }}>{docTitle}</Text>
          {meta.map((m, i) => (
            <Text key={i} style={{ fontSize: 7, color: p.muted, marginTop: i === 0 ? 3 : 1.5 }}>{m}</Text>
          ))}
          {badge ? <View style={{ marginTop: 5 }}><AuraBadge p={p} tone={badge.tone} label={badge.label} /></View> : null}
        </View>
      </View>
      <View style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center' }}>
        <AuraAccentBar p={p} />
        <View style={{ flex: 1, height: 1, backgroundColor: p.lineSoft, marginLeft: 6 }} />
      </View>
    </View>
  )
}

/** Uppercase section label with tiny accent tick. */
export function AuraSectionTitle({ p, children }: { p: AuraPalette; children: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 6 }}>
      <View style={{ width: 3, height: 8, borderRadius: 1.5, backgroundColor: p.accent, marginRight: 5 }} />
      <Text style={{ fontSize: 7.5, fontWeight: 700, color: p.muted, letterSpacing: 1.2, textTransform: 'uppercase' }}>
        {children}
      </Text>
    </View>
  )
}

/** KPI stat card — use in a flexDirection:'row' container with gap. */
export function AuraStatCard({
  p, label, value, hint, emphasis,
}: {
  p: AuraPalette
  label: string
  value: string
  hint?: string
  emphasis?: boolean
}) {
  return (
    <View style={{
      flex: 1,
      backgroundColor: emphasis ? p.accentWash : p.panel,
      borderWidth: 1,
      borderColor: emphasis ? p.accentBorder : p.line,
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 11,
    }}>
      <Text style={{ fontSize: 6.5, fontWeight: 600, color: p.muted, letterSpacing: 1, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13.5, fontWeight: 700, color: emphasis ? p.accent : p.ink, marginTop: 3 }}>
        {value}
      </Text>
      {hint ? <Text style={{ fontSize: 6.5, color: p.faint, marginTop: 2 }}>{hint}</Text> : null}
    </View>
  )
}

/** Rounded-corner table style factory (header wash + zebra rows). */
export function auraTableStyles(p: AuraPalette) {
  return {
    container: {
      borderWidth: 1,
      borderColor: p.line,
      borderRadius: 10,
      backgroundColor: p.mode === 'dark' ? p.panel : p.bg,
    },
    headRow: {
      flexDirection: 'row' as const,
      backgroundColor: p.accentWash,
      borderTopLeftRadius: 9,
      borderTopRightRadius: 9,
      borderBottomWidth: 1,
      borderBottomColor: p.line,
      paddingVertical: 5.5,
      paddingHorizontal: 8,
    },
    th: {
      fontSize: 6.5,
      fontWeight: 700 as const,
      color: p.mode === 'dark' ? p.accentLt : p.accentDim,
      letterSpacing: 0.9,
      textTransform: 'uppercase' as const,
    },
    row: {
      flexDirection: 'row' as const,
      paddingVertical: 5,
      paddingHorizontal: 8,
      borderBottomWidth: 0.5,
      borderBottomColor: p.lineSoft,
    },
    rowAlt: {
      backgroundColor: p.mode === 'dark' ? 'rgba(255,255,255,0.025)' : 'rgba(26,26,46,0.018)',
    },
    lastRow: {
      borderBottomWidth: 0,
      borderBottomLeftRadius: 9,
      borderBottomRightRadius: 9,
    },
  }
}

/** Diagonal status watermark (subtle, behind content). */
export function AuraWatermark({ p, label, tone }: { p: AuraPalette; label: string; tone: AuraBadgeTone }) {
  const color = tone === 'success' ? p.success : tone === 'danger' ? p.danger : p.accent
  const opacity = p.mode === 'dark' ? 0.09 : 0.07
  return (
    <View style={{
      position: 'absolute', top: '40%', left: 24, right: 24,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Text style={{
        fontSize: 88, fontWeight: 700, letterSpacing: 8,
        color, opacity, transform: 'rotate(-28deg)',
      }}>
        {label}
      </Text>
    </View>
  )
}

/** Signature line boxes (employee / management etc.). */
export function AuraSignRow({ p, labels }: { p: AuraPalette; labels: string[] }) {
  return (
    <View wrap={false} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 30 }}>
      {labels.map(label => (
        <View key={label} style={{ width: `${Math.min(38, 90 / labels.length)}%`, borderTopWidth: 1, borderTopColor: p.line, paddingTop: 7 }}>
          <Text style={{ fontSize: 7, color: p.muted, letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</Text>
        </View>
      ))}
    </View>
  )
}

/** Footer pinned to the bottom of the page flow (marginTop:auto in caller if needed). */
export function AuraFooter({ p, lines, pageLabel }: { p: AuraPalette; lines: string[]; pageLabel?: string }) {
  const visible = lines.filter(Boolean)
  return (
    <View wrap={false} style={{ marginTop: 'auto', paddingTop: 10, borderTopWidth: 1, borderTopColor: p.lineSoft }}>
      {visible.map((l, i) => (
        <Text key={i} style={{ fontSize: 6.5, color: p.muted, textAlign: 'center', lineHeight: 1.4 }}>{l}</Text>
      ))}
      {pageLabel ? (
        <Text style={{ fontSize: 6.5, color: p.faint, textAlign: 'right', marginTop: 4 }}>{pageLabel}</Text>
      ) : null}
    </View>
  )
}
