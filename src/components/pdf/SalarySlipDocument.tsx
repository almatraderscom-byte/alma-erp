'use client'
import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import { A4_SIZE, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import type { HREmployee, PayrollRollComputed } from '@/types/hr'

const BG = '#0a0a0c'
const TEXT = '#f2f0ea'
const MUTED = '#9a968c'
const GOLD = '#c9a84c'
const LINE = 'rgba(201,168,76,0.22)'
const ROW_BG = 'rgba(255,255,255,0.03)'
const HEAD_BG = 'rgba(201,168,76,0.12)'

const styles = StyleSheet.create({
  page: {
    paddingTop: A4_PADDING_PT.top,
    paddingBottom: A4_PADDING_PT.bottom,
    paddingHorizontal: A4_PADDING_PT.horizontal,
    fontFamily: getPdfFontFamily(),
    fontSize: 9,
    color: TEXT,
    backgroundColor: BG,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: LINE },
  h1: { fontSize: 17, fontWeight: 700, color: GOLD, marginTop: 4 },
  h2: { fontSize: 11, marginTop: 12, marginBottom: 6, fontWeight: 700, color: GOLD },
  muted: { color: MUTED, marginTop: 2 },
  table: { borderWidth: 1, borderColor: LINE, borderRadius: 2 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: LINE, backgroundColor: ROW_BG },
  cellL: { flex: 1.35, padding: 6 },
  cellR: { flex: 0.75, padding: 6, textAlign: 'right' as const },
  th: { backgroundColor: HEAD_BG, fontWeight: 700 },
  signRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28 },
  signBox: { width: '38%', borderTopWidth: 1, borderTopColor: LINE, paddingTop: 8 },
})

export type SalarySlipModel = {
  companyName: string
  tagline?: string
  logoUrl?: string | null
  employee: HREmployee
  periodLabel: string
  roll: PayrollRollComputed
  generatedAt: string
}

function fmtMoney(n: number) {
  return '৳ ' + Number(n || 0).toLocaleString('en-BD')
}

export function SalarySlipDocument({ model }: { model: SalarySlipModel }) {
  const { employee: e } = model
  return (
    <Document title={`Salary slip — ${e.name}`}>
      <Page size={A4_SIZE} style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            {model.logoUrl ? (
              <Image src={model.logoUrl} style={{ width: 110, maxHeight: 40, marginBottom: 4, objectFit: 'contain' }} />
            ) : null}
            <Text style={styles.h1}>{model.companyName}</Text>
            {model.tagline ? <Text style={styles.muted}>{model.tagline}</Text> : null}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ fontWeight: 700, fontSize: 12, letterSpacing: 1, color: TEXT }}>SALARY SLIP</Text>
            <Text style={styles.muted}>Period: {model.periodLabel}</Text>
            <Text style={styles.muted}>Issued: {model.generatedAt}</Text>
          </View>
        </View>

        <Text style={styles.h2}>Employee</Text>
        <View style={styles.table}>
          <View style={[styles.row, styles.th]}>
            <Text style={styles.cellL}>Field</Text>
            <Text style={styles.cellR}>Value</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Legal name · ID</Text>
            <Text style={styles.cellR}>{`${e.name} (${e.emp_id})`}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Role</Text>
            <Text style={styles.cellR}>{e.role || '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Contact</Text>
            <Text style={styles.cellR}>{e.phone || '—'}</Text>
          </View>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <Text style={styles.cellL}>Joined</Text>
            <Text style={styles.cellR}>{e.joining_date || '—'}</Text>
          </View>
        </View>

        <Text style={styles.h2}>Salary breakdown</Text>
        <View style={styles.table}>
          <View style={[styles.row, styles.th]}>
            <Text style={styles.cellL}>Item</Text>
            <Text style={styles.cellR}>Amount</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Monthly salary (basis)</Text>
            <Text style={styles.cellR}>{fmtMoney(e.monthly_salary)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Paid to date</Text>
            <Text style={styles.cellR}>{fmtMoney(model.roll.salary_paid)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Advance outstanding</Text>
            <Text style={styles.cellR}>{fmtMoney(Math.max(0, model.roll.advance_balance))}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Adjustments (+/−)</Text>
            <Text style={styles.cellR}>{fmtMoney(model.roll.adjustments)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Advance deposits (recovery)</Text>
            <Text style={styles.cellR}>{fmtMoney(model.roll.deposits)}</Text>
          </View>
          <View style={[styles.row, { borderBottomWidth: 0, backgroundColor: 'rgba(201,168,76,0.08)' }]}>
            <Text style={[styles.cellL, { fontWeight: 700 }]}>Balance / due</Text>
            <Text style={[styles.cellR, { fontWeight: 700, color: GOLD }]}>
              {fmtMoney(model.roll.current_due)}
            </Text>
          </View>
        </View>

        <Text style={{ marginTop: 10, fontSize: 8, color: MUTED, lineHeight: 1.4 }}>
          Alma ERP ledger statement. Amounts derive from recorded payroll transactions.
        </Text>

        <View style={styles.signRow}>
          <View style={styles.signBox}>
            <Text style={{ fontSize: 8, color: MUTED }}>Employee</Text>
          </View>
          <View style={styles.signBox}>
            <Text style={{ fontSize: 8, color: MUTED }}>Management</Text>
          </View>
        </View>
      </Page>
    </Document>
  )
}
