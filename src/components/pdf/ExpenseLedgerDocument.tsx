'use client'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { A4_SIZE, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import type { ERPFinanceExpense } from '@/types/hr'

const BG = '#0a0a0c'
const TEXT = '#f2f0ea'
const MUTED = '#9a968c'
const GOLD = '#c9a84c'
const LINE = 'rgba(201,168,76,0.22)'
const HEAD_BG = 'rgba(201,168,76,0.12)'

const styles = StyleSheet.create({
  page: {
    paddingTop: A4_PADDING_PT.top,
    paddingBottom: A4_PADDING_PT.bottom,
    paddingHorizontal: A4_PADDING_PT.horizontal,
    fontFamily: getPdfFontFamily(),
    fontSize: 7.5,
    color: TEXT,
    backgroundColor: BG,
  },
  title: { fontSize: 16, fontWeight: 700, color: GOLD, marginBottom: 4 },
  sub: { fontSize: 9, color: MUTED, marginBottom: 12 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: LINE, paddingVertical: 3.5, backgroundColor: 'rgba(255,255,255,0.02)' },
  cellD: { width: '13%' },
  cellT: { width: '24%' },
  cellC: { width: '16%' },
  cellA: { width: '12%', textAlign: 'right' as const },
  cellS: { width: '35%' },
  th: { fontWeight: 700, backgroundColor: HEAD_BG, paddingVertical: 5, borderBottomColor: LINE },
})

function fmtMoney(n: number) {
  return Number(n || 0).toLocaleString('en-BD')
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
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.sub}>{businessLabel} · {rangeLabel}</Text>

        <View style={[styles.row, styles.th]}>
          <Text style={styles.cellD}>Date</Text>
          <Text style={styles.cellT}>Title</Text>
          <Text style={styles.cellC}>Category</Text>
          <Text style={styles.cellA}>৳</Text>
          <Text style={styles.cellS}>Notes</Text>
        </View>
        {rows.map((r, i) => (
          <View style={styles.row} key={`${r.exp_id || ''}-${r.date}-${i}`}>
            <Text style={styles.cellD}>{String(r.date || '').slice(0, 10)}</Text>
            <Text style={styles.cellT}>{r.title || r.category}</Text>
            <Text style={styles.cellC}>{r.category}</Text>
            <Text style={[styles.cellA, { color: GOLD }]}>{fmtMoney(r.amount)}</Text>
            <Text style={[styles.cellS, { color: MUTED }]}>
              {[r.payment_status, r.notes].filter(Boolean).join(' · ') || '—'}
            </Text>
          </View>
        ))}

        <View style={{ marginTop: 14, flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: LINE }}>
          <Text style={{ fontWeight: 700, color: TEXT }}>Total</Text>
          <Text style={{ fontWeight: 700, color: GOLD }}>৳ {fmtMoney(total)}</Text>
        </View>
      </Page>
    </Document>
  )
}
