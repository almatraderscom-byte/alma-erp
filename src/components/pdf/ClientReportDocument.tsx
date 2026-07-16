/**
 * Client-report PDF — the agent's markdown artifacts exported as a DESIGNED
 * A4 document (owner ask 2026-07-16: client deliverables must be a polished
 * PDF, না markdown dump). Rides the existing Aura design system (coral accent,
 * same header/table language as invoices & salary slips) so every ALMA
 * document a client sees looks like one family.
 *
 * Deliberately NO 'use client' directive: the SERVER route renders this with
 * renderToBuffer (a long Bangla report froze the browser main thread for
 * minutes — 2026-07-16 incident; heavy shaping belongs on the server).
 */
import React from 'react'
import { Document, Page, Text, View } from '@react-pdf/renderer'
import { A4_SIZE, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import {
  auraPalette,
  AuraBackdrop,
  AuraDocHeader,
  AuraSectionTitle,
  AuraAccentBar,
  AuraFooter,
  auraTableStyles,
  type AuraPalette,
} from './aura'
import { softBreakLongTokens, type InlineSpan, type MarkdownBlock } from '@/lib/pdf/markdown-blocks'

export interface ClientReportModel {
  title: string
  /** e.g. "প্রস্তুত: ALMA Digital · ১৬ জুলাই ২০২৬" */
  metaLines: string[]
  blocks: MarkdownBlock[]
  companyName?: string
  tagline?: string
  /** Server render passes the family it registered; client falls back to fonts.ts state. */
  fontFamily?: string
}

function Spans({ spans, size, color }: { spans: InlineSpan[]; size: number; color: string }) {
  return (
    <Text style={{ fontSize: size, color, lineHeight: 1.55 }}>
      {spans.map((s, i) => (
        <Text key={i} style={s.bold ? { fontWeight: 700 } : undefined}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

function TableBlock({ p, header, rows }: { p: AuraPalette; header: string[]; rows: string[][] }) {
  const t = auraTableStyles(p)
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1)
  const widths = Array.from({ length: cols }, (_, c) =>
    // First column breathes a bit wider when there are 3+ columns.
    cols >= 3 && c === 0 ? 1.4 : 1,
  )
  return (
    <View style={{ ...t.container, marginTop: 6, marginBottom: 8 }} wrap>
      {header.length > 0 && (
        <View style={t.headRow} wrap={false}>
          {header.map((h, c) => (
            <Text key={c} style={{ ...t.th, flex: widths[c] ?? 1, paddingRight: 6 }}>
              {h}
            </Text>
          ))}
        </View>
      )}
      {rows.map((r, i) => (
        <View
          key={i}
          style={{ ...t.row, ...(i % 2 === 1 ? t.rowAlt : {}), ...(i === rows.length - 1 ? t.lastRow : {}) }}
          wrap={false}
        >
          {Array.from({ length: cols }, (_, c) => (
            <Text key={c} style={{ fontSize: 7.5, color: p.ink, flex: widths[c] ?? 1, paddingRight: 6, lineHeight: 1.45 }}>
              {r[c] ?? ''}
            </Text>
          ))}
        </View>
      ))}
    </View>
  )
}

function Blocks({ p, blocks }: { p: AuraPalette; blocks: MarkdownBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          if (b.level === 1) {
            return (
              <View key={i} wrap={false} style={{ marginTop: 14, marginBottom: 4 }}>
                <Text style={{ fontSize: 12.5, fontWeight: 700, color: p.ink }}>{b.text}</Text>
                <View style={{ marginTop: 4 }}>
                  <AuraAccentBar p={p} width={34} />
                </View>
              </View>
            )
          }
          if (b.level === 2) return <AuraSectionTitle key={i} p={p}>{b.text}</AuraSectionTitle>
          return (
            <Text key={i} style={{ fontSize: 9, fontWeight: 700, color: p.ink, marginTop: 8, marginBottom: 3 }}>
              {b.text}
            </Text>
          )
        }
        if (b.kind === 'paragraph') {
          return (
            <View key={i} style={{ marginBottom: 5 }}>
              <Spans spans={b.spans} size={8.5} color={p.ink} />
            </View>
          )
        }
        if (b.kind === 'list') {
          return (
            <View key={i} style={{ marginBottom: 6, marginTop: 2 }}>
              {b.items.map((item, j) => (
                <View key={j} style={{ flexDirection: 'row', marginBottom: 2.5, paddingLeft: 2 }} wrap={false}>
                  <Text style={{ fontSize: 8.5, color: p.accent, width: 14, fontWeight: 700 }}>
                    {b.ordered ? `${j + 1}.` : '•'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Spans spans={item} size={8.5} color={p.ink} />
                  </View>
                </View>
              ))}
            </View>
          )
        }
        if (b.kind === 'table') return <TableBlock key={i} p={p} header={b.header} rows={b.rows} />
        return <View key={i} style={{ height: 1, backgroundColor: p.lineSoft, marginVertical: 8 }} />
      })}
    </>
  )
}

export function ClientReportDocument({ model }: { model: ClientReportModel }) {
  const p = auraPalette('light')
  const fontFamily = model.fontFamily ?? getPdfFontFamily()
  return (
    <Document title={model.title} author={model.companyName ?? 'ALMA Digital'}>
      <Page
        size={A4_SIZE}
        style={{ paddingTop: A4_PADDING_PT.top, paddingBottom: A4_PADDING_PT.bottom + 14, paddingHorizontal: A4_PADDING_PT.horizontal, fontFamily, backgroundColor: p.bg }}
      >
        <AuraBackdrop p={p} />
        <AuraDocHeader
          p={p}
          companyName={model.companyName ?? 'ALMA Digital'}
          tagline={model.tagline ?? 'Digital Growth & SEO'}
          docTitle="REPORT"
          meta={model.metaLines}
        />
        <Text style={{ fontSize: 14, fontWeight: 700, color: p.ink, marginBottom: 8, lineHeight: 1.4 }}>
          {softBreakLongTokens(model.title)}
        </Text>
        <Blocks p={p} blocks={model.blocks} />
        <AuraFooter p={p} lines={[model.companyName ?? 'ALMA Digital']} pageLabel="Page" />
      </Page>
    </Document>
  )
}
