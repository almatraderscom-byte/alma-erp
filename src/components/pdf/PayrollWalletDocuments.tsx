'use client'

import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { A4_SIZE, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import { pdfMoney } from '@/lib/pdf/format'
import {
  auraPalette, AuraBackdrop, AuraDocHeader, AuraStatCard, AuraFooter, auraTableStyles,
} from './aura'
import type { PayrollWallet, WalletEntryDto } from '@/types/payroll-wallet'

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
  // Payroll summary table cells (Employee wide, numerics right-aligned)
  cName: { flex: 1.5, paddingRight: 6 },
  cNum: { flex: 1, textAlign: 'right' as const },
  // Statement table cells
  eDate: { flex: 1.1, paddingRight: 4 },
  eType: { flex: 1.5, paddingRight: 4 },
  eNum: { flex: 1, textAlign: 'right' as const },
})

function fmt(n: number) {
  return pdfMoney(n)
}

function WalletTable({ wallets }: { wallets: PayrollWallet[] }) {
  return (
    <View style={t.container}>
      <View style={t.headRow}>
        <Text style={[t.th, styles.cName]}>Employee</Text>
        <Text style={[t.th, styles.cNum]}>Salary</Text>
        <Text style={[t.th, styles.cNum]}>Commission</Text>
        <Text style={[t.th, styles.cNum]}>Bonus</Text>
        <Text style={[t.th, styles.cNum]}>Deductions</Text>
        <Text style={[t.th, styles.cNum]}>Earned</Text>
        <Text style={[t.th, styles.cNum]}>Held Balance</Text>
      </View>
      {wallets.map((w, i) => (
        <View
          key={`${w.businessId}:${w.employeeId}`}
          style={[
            t.row,
            ...(i % 2 === 1 ? [t.rowAlt] : []),
            ...(i === wallets.length - 1 ? [t.lastRow] : []),
          ]}
        >
          <Text style={[styles.cName, { fontWeight: 600 }]}>{w.name || w.employeeId}</Text>
          <Text style={styles.cNum}>{fmt(w.summary.totalAccrued)}</Text>
          <Text style={styles.cNum}>{fmt(w.summary.totalCommissions)}</Text>
          <Text style={styles.cNum}>{fmt(w.summary.totalBonuses)}</Text>
          <Text style={styles.cNum}>{fmt(w.summary.totalMealDeductions + w.summary.totalPenalties)}</Text>
          <Text style={styles.cNum}>{fmt(w.summary.lifetimeEarned)}</Text>
          <Text style={[styles.cNum, { fontWeight: 700, color: p.accent }]}>{fmt(w.summary.companyLiability)}</Text>
        </View>
      ))}
    </View>
  )
}

function EntryTable({ entries }: { entries: WalletEntryDto[] }) {
  return (
    <View style={t.container}>
      <View style={t.headRow}>
        <Text style={[t.th, styles.eDate]}>Date</Text>
        <Text style={[t.th, styles.eType]}>Type</Text>
        <Text style={[t.th, styles.eNum]}>Movement</Text>
        <Text style={[t.th, styles.eNum]}>Running</Text>
      </View>
      {entries.map((e, i) => {
        const moveColor = e.signedAmount > 0 ? p.success : e.signedAmount < 0 ? p.danger : p.muted
        return (
          <View
            key={e.id || `${e.date}-${e.type}`}
            style={[
              t.row,
              ...(i % 2 === 1 ? [t.rowAlt] : []),
              ...(i === entries.length - 1 ? [t.lastRow] : []),
            ]}
          >
            <Text style={styles.eDate}>{String(e.date).slice(0, 10)}</Text>
            <Text style={[styles.eType, { textTransform: 'capitalize' }]}>{e.type.replace(/_/g, ' ')}</Text>
            <Text style={[styles.eNum, { color: moveColor, fontWeight: 600 }]}>{fmt(e.signedAmount)}</Text>
            <Text style={[styles.eNum, { fontWeight: 600 }]}>{fmt(e.runningBalance)}</Text>
          </View>
        )
      })}
    </View>
  )
}

export function BusinessPayrollSummaryDocument({
  wallets,
  businessName,
  generatedAt,
}: {
  wallets: PayrollWallet[]
  businessName: string
  generatedAt: string
}) {
  const liability = wallets.reduce((a, w) => a + w.summary.companyLiability, 0)
  const commission = wallets.reduce((a, w) => a + w.summary.totalCommissions, 0)
  const bonuses = wallets.reduce((a, w) => a + w.summary.totalBonuses, 0)
  return (
    <Document title={`Payroll summary — ${businessName}`}>
      <Page size={A4_SIZE} style={styles.page}>
        <AuraBackdrop p={p} />
        <AuraDocHeader
          p={p}
          companyName={businessName}
          docTitle="PAYROLL SUMMARY"
          meta={[`Generated ${generatedAt}`, `${wallets.length} employees`]}
        />
        <View style={styles.statRow}>
          <AuraStatCard p={p} label="Total Liability" value={fmt(liability)} emphasis />
          <AuraStatCard p={p} label="Commission" value={fmt(commission)} />
          <AuraStatCard p={p} label="Bonuses" value={fmt(bonuses)} />
        </View>
        <WalletTable wallets={wallets} />
        <AuraFooter p={p} lines={[`${businessName} · Payroll wallet summary · ALMA ERP`]} />
      </Page>
    </Document>
  )
}

export function MonthlyPayrollReportDocument(props: { wallets: PayrollWallet[]; businessName: string; generatedAt: string }) {
  return <BusinessPayrollSummaryDocument {...props} />
}

export function SalaryLedgerDocument(props: { wallets: PayrollWallet[]; businessName: string; generatedAt: string }) {
  return <BusinessPayrollSummaryDocument {...props} />
}

export function EmployeeStatementDocument({
  wallet,
  generatedAt,
}: {
  wallet: PayrollWallet & { entries?: WalletEntryDto[] }
  generatedAt: string
}) {
  const entries = wallet.entries || wallet.latestEntries || []
  return (
    <Document title={`Employee statement — ${wallet.name || wallet.employeeId}`}>
      <Page size={A4_SIZE} style={styles.page}>
        <AuraBackdrop p={p} />
        <AuraDocHeader
          p={p}
          companyName={wallet.name || wallet.employeeId}
          tagline={wallet.employeeId}
          docTitle="WALLET STATEMENT"
          meta={[`Generated ${generatedAt}`]}
        />
        <View style={styles.statRow}>
          <AuraStatCard p={p} label="Held Balance" value={fmt(wallet.summary.companyLiability)} emphasis />
          <AuraStatCard p={p} label="Entries" value={String(entries.length)} />
        </View>
        <EntryTable entries={entries} />
        <AuraFooter p={p} lines={[`${wallet.name || wallet.employeeId} · Wallet statement · ALMA ERP`]} />
      </Page>
    </Document>
  )
}
