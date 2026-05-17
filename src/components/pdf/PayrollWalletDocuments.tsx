'use client'

import React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { A4_SIZE, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import { pdfMoney } from '@/lib/pdf/format'
import type { PayrollWallet, WalletEntryDto } from '@/types/payroll-wallet'

const GOLD = '#c9a84c'
const BG = '#0a0a0c'
const TEXT = '#f2f0ea'
const MUTED = '#9a968c'
const LINE = 'rgba(201,168,76,0.22)'

const styles = StyleSheet.create({
  page: {
    paddingTop: A4_PADDING_PT.top,
    paddingBottom: A4_PADDING_PT.bottom,
    paddingHorizontal: A4_PADDING_PT.horizontal,
    fontFamily: getPdfFontFamily(),
    fontSize: 8,
    color: TEXT,
    backgroundColor: BG,
  },
  header: { borderBottomWidth: 1, borderBottomColor: LINE, paddingBottom: 10, marginBottom: 12 },
  h1: { color: GOLD, fontSize: 16, fontWeight: 700 },
  muted: { color: MUTED, marginTop: 3 },
  section: { marginTop: 10 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: LINE },
  th: { backgroundColor: 'rgba(201,168,76,0.12)', fontWeight: 700 },
  c1: { flex: 1.1, padding: 5 },
  c2: { flex: 1.5, padding: 5 },
  cr: { flex: 1, padding: 5, textAlign: 'right' as const },
})

function fmt(n: number) {
  return pdfMoney(n)
}

function WalletRows({ wallets }: { wallets: PayrollWallet[] }) {
  return (
    <View style={styles.section}>
      <View style={[styles.row, styles.th]}>
        <Text style={styles.c2}>Employee</Text>
        <Text style={styles.cr}>Salary</Text>
        <Text style={styles.cr}>Commission</Text>
        <Text style={styles.cr}>Bonus</Text>
        <Text style={styles.cr}>Deductions</Text>
        <Text style={styles.cr}>Earned</Text>
        <Text style={styles.cr}>Held Balance</Text>
      </View>
      {wallets.map(w => (
        <View key={`${w.businessId}:${w.employeeId}`} style={styles.row}>
          <Text style={styles.c2}>{w.name || w.employeeId}</Text>
          <Text style={styles.cr}>{fmt(w.summary.totalAccrued)}</Text>
          <Text style={styles.cr}>{fmt(w.summary.totalCommissions)}</Text>
          <Text style={styles.cr}>{fmt(w.summary.totalBonuses)}</Text>
          <Text style={styles.cr}>{fmt(w.summary.totalMealDeductions + w.summary.totalPenalties)}</Text>
          <Text style={styles.cr}>{fmt(w.summary.lifetimeEarned)}</Text>
          <Text style={styles.cr}>{fmt(w.summary.companyLiability)}</Text>
        </View>
      ))}
    </View>
  )
}

function EntryRows({ entries }: { entries: WalletEntryDto[] }) {
  return (
    <View style={styles.section}>
      <View style={[styles.row, styles.th]}>
        <Text style={styles.c1}>Date</Text>
        <Text style={styles.c2}>Type</Text>
        <Text style={styles.cr}>Movement</Text>
        <Text style={styles.cr}>Running</Text>
      </View>
      {entries.map(e => (
        <View key={e.id || `${e.date}-${e.type}`} style={styles.row}>
          <Text style={styles.c1}>{String(e.date).slice(0, 10)}</Text>
          <Text style={styles.c2}>{e.type.replace(/_/g, ' ')}</Text>
          <Text style={styles.cr}>{fmt(e.signedAmount)}</Text>
          <Text style={styles.cr}>{fmt(e.runningBalance)}</Text>
        </View>
      ))}
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
        <View style={styles.header}>
          <Text style={styles.h1}>Business Payroll Summary</Text>
          <Text style={styles.muted}>{businessName} · Generated {generatedAt}</Text>
          <Text style={styles.muted}>Total company liability: {fmt(liability)}</Text>
          <Text style={styles.muted}>Commission: {fmt(commission)} · Bonuses: {fmt(bonuses)}</Text>
        </View>
        <WalletRows wallets={wallets} />
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
  return (
    <Document title={`Employee statement — ${wallet.name || wallet.employeeId}`}>
      <Page size={A4_SIZE} style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.h1}>Employee Wallet Statement</Text>
          <Text style={styles.muted}>{wallet.name || wallet.employeeId} · {wallet.employeeId}</Text>
          <Text style={styles.muted}>Generated {generatedAt} · Held balance {fmt(wallet.summary.companyLiability)}</Text>
        </View>
        <EntryRows entries={wallet.entries || wallet.latestEntries || []} />
      </Page>
    </Document>
  )
}
