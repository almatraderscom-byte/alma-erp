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
const PAID_COLOR = 'rgba(22, 163, 74, 0.15)'
const UNPAID_COLOR = 'rgba(220, 38, 38, 0.15)'

const styles = StyleSheet.create({
  page: {
    position: 'relative',
    paddingTop: A4_PADDING_PT.top,
    paddingBottom: A4_PADDING_PT.bottom,
    paddingHorizontal: A4_PADDING_PT.horizontal,
    fontFamily: getPdfFontFamily(),
    fontSize: 9,
    color: TEXT,
    backgroundColor: BG,
  },
  watermarkWrap: {
    position: 'absolute',
    top: '38%',
    left: 24,
    right: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  watermarkText: {
    fontSize: 96,
    fontWeight: 700,
    letterSpacing: 6,
    transform: 'rotate(-30deg)',
  },
  content: {
    position: 'relative',
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
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, paddingHorizontal: 6 },
  detailDivider: { borderTopWidth: 1, borderTopColor: LINE, marginTop: 4, paddingTop: 6 },
  signRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28 },
  signBox: { width: '38%', borderTopWidth: 1, borderTopColor: LINE, paddingTop: 8 },
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

function DetailLine({ label, amount, emphasize }: { label: string; amount: number; emphasize?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <Text style={{ color: emphasize ? GOLD : TEXT, fontWeight: emphasize ? 700 : 400 }}>{label}</Text>
      <Text style={{ color: emphasize ? GOLD : TEXT, fontWeight: emphasize ? 700 : 400 }}>{fmtMoney(amount)}</Text>
    </View>
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
  const penaltyDisplay = breakdown.penalty > 0 ? -breakdown.penalty : 0
  const isPaid = breakdown.isPaid
  const watermarkColor = isPaid ? PAID_COLOR : UNPAID_COLOR

  return (
    <Document title={`Salary slip — ${e.name}`}>
      <Page size={A4_SIZE} style={styles.page}>
        <View style={styles.watermarkWrap}>
          <Text style={[styles.watermarkText, { color: watermarkColor }]}>
            {isPaid ? 'PAID' : 'UNPAID'}
          </Text>
        </View>

        <View style={styles.content}>
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

          <Text style={styles.h2}>Salary details</Text>
          <View style={[styles.table, { paddingVertical: 4 }]}>
            <DetailLine label="Basic Salary" amount={breakdown.basicSalary} />
            <DetailLine label="Late Attendance Penalty" amount={penaltyDisplay} />
            <View style={styles.detailDivider}>
              <DetailLine label="NET PAY" amount={breakdown.netPay} emphasize />
            </View>
          </View>

          <Text style={{ marginTop: 10, fontSize: 8, color: MUTED, lineHeight: 1.4 }}>
            Alma ERP salary statement for {model.periodLabel}.
          </Text>

          <View style={styles.signRow}>
            <View style={styles.signBox}>
              <Text style={{ fontSize: 8, color: MUTED }}>Employee</Text>
            </View>
            <View style={styles.signBox}>
              <Text style={{ fontSize: 8, color: MUTED }}>Management</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  )
}
