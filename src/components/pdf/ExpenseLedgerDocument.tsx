'use client'
import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { A4_SIZE, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import { pdfMoney } from '@/lib/pdf/format'
import {
  auraPalette, AuraBackdrop, AuraDocHeader, AuraStatCard, AuraFooter, auraTableStyles,
} from './aura'
import type { ERPFinanceExpense } from '@/types/hr'

const p = auraPalette('light')
const t = auraTableStyles(p)

const styles = StyleSheet.create({
  page: {
    paddingTop: A4_PADDING_PT.top,
    paddingBottom: A4_PADDING_PT.bottom,
    paddingHorizontal: A4_PADDING_PT.horizontal,
    fontFamily: getPdfFontFamily(),
    fontSize: 7.5,
    color: p.ink,
    backgroundColor: p.bg,
  },
  statRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  cellD: { width: '13%', paddingRight: 4 },
  cellT: { width: '24%', paddingRight: 4 },
  cellC: { width: '16%', paddingRight: 4 },
  cellA: { width: '12%', textAlign: 'right' as const },
  cellS: { width: '35%', paddingLeft: 8 },
  totalStrip: {
    alignSelf: 'flex-end' as const,
    marginTop: 12,
    backgroundColor: p.accentWash,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    flexDirection: 'row' as const,
    gap: 8,
  },
})

function fmtMoney(n: number) {
  return pdfMoney(n)
}

export function ExpenseLedgerDocument({
  title,
  businessLabel,
  rangeLabel,
  rows,
  total,
}: {
  title: string
  businessLabel: string
  rangeLabel: string
  rows: ERPFinanceExpense[]
  total: number
}) {
  return (
    <Document title={`${title} — ${businessLabel}`}>
      <Page size={A4_SIZE} style={styles.page}>
        <AuraBackdrop p={p} />
        <AuraDocHeader
          p={p}
          companyName={businessLabel}
          docTitle={title.toUpperCase()}
          meta={[rangeLabel, `${rows.length} entries`]}
        />
        <View style={styles.statRow}>
          <AuraStatCard p={p} label="Total Spend" value={fmtMoney(total)} emphasis />
          <AuraStatCard p={p} label="Entries" value={String(rows.length)} hint={rangeLabel} />
        </View>

        <View style={t.container}>
          <View style={t.headRow}>
            <Text style={[t.th, styles.cellD]}>Date</Text>
            <Text style={[t.th, styles.cellT]}>Title</Text>
            <Text style={[t.th, styles.cellC]}>Category</Text>
            <Text style={[t.th, styles.cellA]}>Amount</Text>
            <Text style={[t.th, styles.cellS]}>Notes</Text>
          </View>
          {rows.map((r, i) => (
            <View
              key={`${r.exp_id || ''}-${r.date}-${i}`}
              style={[
                t.row,
                ...(i % 2 === 1 ? [t.rowAlt] : []),
                ...(i === rows.length - 1 ? [t.lastRow] : []),
              ]}
            >
              <Text style={styles.cellD}>{String(r.date || '').slice(0, 10)}</Text>
              <Text style={styles.cellT}>{r.title || r.category}</Text>
              <Text style={styles.cellC}>{r.category}</Text>
              <Text style={[styles.cellA, { color: p.accent, fontWeight: 600 }]}>{fmtMoney(r.amount)}</Text>
              <Text style={[styles.cellS, { color: p.muted }]}>
                {[r.payment_status, r.notes].filter(Boolean).join(' · ') || '—'}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.totalStrip}>
          <Text style={{ fontWeight: 700, color: p.ink }}>Total</Text>
          <Text style={{ fontWeight: 700, color: p.accent }}>{fmtMoney(total)}</Text>
        </View>

        <AuraFooter p={p} lines={[`${businessLabel} · ${rangeLabel} · ALMA ERP`]} />
      </Page>
    </Document>
  )
}
