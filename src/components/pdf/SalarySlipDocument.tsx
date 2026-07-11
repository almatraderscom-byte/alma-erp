'use client'
import React from 'react'
import { Document, Page, Text, View } from '@react-pdf/renderer'
import { A4_SIZE, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import { pdfMoney } from '@/lib/pdf/format'
import type { SalarySlipBreakdown } from '@/lib/salary-slip'
import type { HREmployee } from '@/types/hr'
import type { InvoicePdfBranding } from '@/lib/pdf/types'
import {
  auraPalette,
  AuraBackdrop,
  AuraDocHeader,
  AuraSectionTitle,
  AuraWatermark,
  AuraSignRow,
  AuraFooter,
  auraTableStyles,
  type AuraPalette,
} from './aura'

export type SalarySlipModel = {
  companyName: string
  tagline?: string
  logoUrl?: string | null
  employee: HREmployee
  periodLabel: string
  breakdown: SalarySlipBreakdown
  generatedAt: string
}

export type SalarySlipPdfBranding = Pick<InvoicePdfBranding, 'logoDataUrl'>

function InfoCell({ p, label, value }: { p: AuraPalette; label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 6.5, fontWeight: 600, color: p.muted, letterSpacing: 1, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <Text style={{ fontSize: 9.5, fontWeight: 600, color: p.ink, marginTop: 2.5 }}>{value}</Text>
    </View>
  )
}

export function SalarySlipDocument({
  model,
  branding,
}: {
  model: SalarySlipModel
  branding?: SalarySlipPdfBranding
}) {
  const { employee: e, breakdown } = model
  const p = auraPalette('light')
  const t = auraTableStyles(p)
  const logoDataUrl = branding?.logoDataUrl
  const penaltyDisplay = breakdown.penalty > 0 ? -breakdown.penalty : 0
  const isPaid = breakdown.isPaid

  return (
    <Document title={`Salary slip — ${e.name}`}>
      <Page
        size={A4_SIZE}
        style={{
          position: 'relative',
          paddingTop: A4_PADDING_PT.top,
          paddingBottom: A4_PADDING_PT.bottom,
          paddingHorizontal: A4_PADDING_PT.horizontal,
          fontFamily: getPdfFontFamily(),
          fontSize: 8.5,
          color: p.ink,
          backgroundColor: p.bg,
        }}
      >
        <AuraBackdrop p={p} />
        <AuraWatermark p={p} label={isPaid ? 'PAID' : 'UNPAID'} tone={isPaid ? 'success' : 'danger'} />

        <AuraDocHeader
          p={p}
          logoDataUrl={logoDataUrl}
          companyName={model.companyName}
          tagline={model.tagline}
          docTitle="SALARY SLIP"
          meta={[`Period: ${model.periodLabel}`, `Issued: ${model.generatedAt}`]}
          badge={{ tone: isPaid ? 'success' : 'danger', label: isPaid ? 'Paid' : 'Unpaid' }}
        />

        <AuraSectionTitle p={p}>Employee</AuraSectionTitle>
        <View
          wrap={false}
          style={{
            backgroundColor: p.panel,
            borderWidth: 1,
            borderColor: p.line,
            borderRadius: 10,
            padding: 11,
          }}
        >
          <View style={{ flexDirection: 'row' }}>
            <InfoCell p={p} label="Name" value={e.name} />
            <InfoCell p={p} label="Employee ID" value={e.emp_id} />
          </View>
          <View style={{ flexDirection: 'row', marginTop: 9 }}>
            <InfoCell p={p} label="Role" value={e.role || '—'} />
            <InfoCell p={p} label="Contact" value={e.phone || '—'} />
          </View>
        </View>

        <AuraSectionTitle p={p}>Salary details</AuraSectionTitle>
        <View wrap={false} style={t.container}>
          <View style={t.headRow}>
            <Text style={[t.th, { flex: 1.4 }]}>Description</Text>
            <Text style={[t.th, { flex: 0.6, textAlign: 'right' }]}>Amount</Text>
          </View>
          <View style={t.row}>
            <Text style={{ flex: 1.4, fontSize: 8.5, color: p.ink }}>Basic Salary</Text>
            <Text style={{ flex: 0.6, fontSize: 8.5, color: p.ink, textAlign: 'right' }}>
              {pdfMoney(breakdown.basicSalary)}
            </Text>
          </View>
          <View style={[t.row, t.rowAlt, t.lastRow]}>
            <Text style={{ flex: 1.4, fontSize: 8.5, color: p.ink }}>Late Attendance Penalty</Text>
            <Text style={{ flex: 0.6, fontSize: 8.5, color: penaltyDisplay < 0 ? p.danger : p.ink, textAlign: 'right' }}>
              {pdfMoney(penaltyDisplay)}
            </Text>
          </View>
        </View>

        <View
          wrap={false}
          style={{
            marginTop: 14,
            backgroundColor: p.accentWash,
            borderWidth: 1,
            borderColor: p.accentBorder,
            borderRadius: 12,
            padding: 14,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <View>
            <Text style={{ fontSize: 7, fontWeight: 700, color: p.accentDim, letterSpacing: 1.5, textTransform: 'uppercase' }}>
              NET PAY
            </Text>
            <Text style={{ fontSize: 6.5, color: p.muted, marginTop: 2.5 }}>{model.periodLabel}</Text>
          </View>
          <Text style={{ fontSize: 20, fontWeight: 700, color: p.accent }}>
            {pdfMoney(breakdown.netPay)}
          </Text>
        </View>

        <Text style={{ marginTop: 10, fontSize: 7, color: p.muted, lineHeight: 1.4 }}>
          Alma ERP salary statement for {model.periodLabel}.
        </Text>

        <AuraSignRow p={p} labels={['Employee', 'Management']} />

        <AuraFooter p={p} lines={[`${model.companyName} — generated by ALMA ERP`]} />
      </Page>
    </Document>
  )
}
