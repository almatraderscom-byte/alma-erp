'use client'
import React from 'react'
import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer'
import { A4_SIZE, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import { pdfMoney } from '@/lib/pdf/format'
import type { SalarySlipBreakdown } from '@/lib/salary-slip'
import type { HREmployee } from '@/types/hr'
import type { InvoicePdfBranding } from '@/lib/pdf/types'

const BG = '#0a0a0c'
const TEXT = '#f2f0ea'
const MUTED = '#9a968c'
const GOLD = '#c9a84c'
const LINE = 'rgba(201,168,76,0.22)'
const ROW_BG = 'rgba(255,255,255,0.03)'
const HEAD_BG = 'rgba(201,168,76,0.12)'
const NET_BG = 'rgba(201,168,76,0.08)'

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
  headerLeft: { flexDirection: 'row', alignItems: 'center', maxWidth: '55%' },
  headerBrand: { flexShrink: 1 },
  headerLogo: { width: 60, height: 60, marginRight: 12, objectFit: 'contain' as const },
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
  emptyRow: { padding: 8, color: MUTED, fontSize: 8 },
})

export type SalarySlipModel = {
  companyName: string
  tagline?: string
  logoUrl?: string | null
  employee: HREmployee
  periodLabel: string
  breakdown: SalarySlipBreakdown
  generatedAt: string
}

function fmtMoney(n: number) {
  return pdfMoney(n)
}

function BreakdownSection({
  title,
  lines,
  total,
  totalLabel,
}: {
  title: string
  lines: SalarySlipBreakdown['earnings']
  total: number
  totalLabel: string
}) {
  return (
    <>
      <Text style={styles.h2}>{title}</Text>
      <View style={styles.table}>
        <View style={[styles.row, styles.th]}>
          <Text style={styles.cellL}>Item</Text>
          <Text style={styles.cellR}>Amount</Text>
        </View>
        {lines.length === 0 ? (
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <Text style={styles.emptyRow}>No entries for this period.</Text>
          </View>
        ) : (
          lines.map(line => (
            <View key={line.label} style={styles.row}>
              <Text style={styles.cellL}>{line.label}</Text>
              <Text style={styles.cellR}>{fmtMoney(line.amount)}</Text>
            </View>
          ))
        )}
        <View style={[styles.row, { borderBottomWidth: 0, backgroundColor: NET_BG }]}>
          <Text style={[styles.cellL, { fontWeight: 700 }]}>{totalLabel}</Text>
          <Text style={[styles.cellR, { fontWeight: 700, color: GOLD }]}>{fmtMoney(total)}</Text>
        </View>
      </View>
    </>
  )
}

export type SalarySlipPdfBranding = Pick<InvoicePdfBranding, 'logoDataUrl'>

export function SalarySlipDocument({
  model,
  branding,
}: {
  model: SalarySlipModel
  branding?: SalarySlipPdfBranding
}) {
  const { employee: e, breakdown } = model
  const logoDataUrl = branding?.logoDataUrl
  return (
    <Document title={`Salary slip — ${e.name}`}>
      <Page size={A4_SIZE} style={styles.page}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            {logoDataUrl ? <Image src={logoDataUrl} style={styles.headerLogo} /> : null}
            <View style={styles.headerBrand}>
              <Text style={styles.h1}>{model.companyName}</Text>
              {model.tagline ? <Text style={styles.muted}>{model.tagline}</Text> : null}
            </View>
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
            <Text style={styles.cellL}>Name</Text>
            <Text style={styles.cellR}>{e.name}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Employee ID</Text>
            <Text style={styles.cellR}>{e.emp_id}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.cellL}>Role</Text>
            <Text style={styles.cellR}>{e.role || '—'}</Text>
          </View>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <Text style={styles.cellL}>Contact</Text>
            <Text style={styles.cellR}>{e.phone || '—'}</Text>
          </View>
        </View>

        <BreakdownSection
          title="Earnings"
          lines={breakdown.earnings}
          total={breakdown.totalEarnings}
          totalLabel="Total earnings"
        />

        <BreakdownSection
          title="Deductions"
          lines={breakdown.deductions}
          total={breakdown.totalDeductions}
          totalLabel="Total deductions"
        />

        <Text style={styles.h2}>Net pay</Text>
        <View style={styles.table}>
          <View style={[styles.row, { borderBottomWidth: 0, backgroundColor: NET_BG }]}>
            <Text style={[styles.cellL, { fontWeight: 700, fontSize: 11 }]}>Net pay (earnings − deductions)</Text>
            <Text style={[styles.cellR, { fontWeight: 700, fontSize: 11, color: GOLD }]}>
              {fmtMoney(breakdown.netPay)}
            </Text>
          </View>
        </View>

        <Text style={{ marginTop: 10, fontSize: 8, color: MUTED, lineHeight: 1.4 }}>
          Alma ERP ledger statement for {model.periodLabel}. Amounts are grouped from wallet entries recorded in this
          period only.
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
