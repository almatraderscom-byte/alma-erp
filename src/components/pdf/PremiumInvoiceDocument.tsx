import React from 'react'
import {
  Document, Page, View, Text, Image, StyleSheet,
} from '@react-pdf/renderer'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import { compactScale } from '@/lib/pdf/models'
import { pdfMoney, pdfDate } from '@/lib/pdf/format'
import { A4_SIZE, A4_PADDING_PT, A4_WIDTH_PT, A4_HEIGHT_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'

const MAX_FIRST_PAGE_ROWS = 12
const MAX_CONTINUATION_ROWS = 24
const WATERMARK_WIDTH = 360
const WATERMARK_HEIGHT = 145

function chunkRows<T>(rows: T[], firstPageMax: number, nextPageMax: number): T[][] {
  if (rows.length <= firstPageMax) return [rows]
  const pages = [rows.slice(0, firstPageMax)]
  for (let i = firstPageMax; i < rows.length; i += nextPageMax) {
    pages.push(rows.slice(i, i + nextPageMax))
  }
  return pages
}

function buildStyles(model: InvoicePdfModel) {
  const scale = compactScale(model)
  const dark = model.theme === 'dark'
  const bg = dark ? '#0a0a0c' : '#ffffff'
  const text = dark ? '#f2f0ea' : '#1a1a1a'
  const muted = dark ? '#9a968c' : '#666666'
  const gold = model.branding.colorPrimary
  const softGold = dark ? '#2a2418' : '#f7efd8'
  const panel = dark ? '#101014' : '#fbfaf6'
  const line = dark ? '#3a3427' : '#e8dcc0'

  return StyleSheet.create({
    page: {
      backgroundColor: bg,
      color: text,
      paddingTop: A4_PADDING_PT.top,
      paddingBottom: A4_PADDING_PT.bottom,
      paddingHorizontal: A4_PADDING_PT.horizontal,
      fontFamily: getPdfFontFamily(),
      fontSize: scale.base,
    },
    watermark: {
      position: 'absolute',
      left: (A4_WIDTH_PT - WATERMARK_WIDTH) / 2,
      top: (A4_HEIGHT_PT - WATERMARK_HEIGHT) / 2 + 38,
      width: WATERMARK_WIDTH,
      height: WATERMARK_HEIGHT,
      objectFit: 'contain' as const,
      opacity: model.branding.watermarkOpacity ?? 0.06,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
      paddingBottom: 9,
      borderBottomWidth: 1.2,
      borderBottomColor: line,
    },
    brandRow: { flexDirection: 'row', alignItems: 'center' },
    logoBox: {
      width: 78,
      height: 32,
      marginRight: 9,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: line,
      backgroundColor: dark ? '#070708' : '#ffffff',
    },
    logo: { width: 72, height: 24, objectFit: 'contain' as const },
    logoFallback: { fontSize: scale.base + 3, fontWeight: 700, color: gold },
    brandName: { fontSize: scale.base + 5, fontWeight: 700, color: gold },
    brandTag: { fontSize: scale.small, color: muted, marginTop: 2, maxWidth: 250 },
    invTitle: { fontSize: scale.base + 9, fontWeight: 700, textAlign: 'right', color: text },
    invMeta: { fontSize: scale.small, color: muted, textAlign: 'right', marginTop: 2 },
    statusPill: {
      marginTop: 6,
      alignSelf: 'flex-end',
      fontSize: scale.small,
      paddingVertical: 3,
      paddingHorizontal: 8,
      backgroundColor: softGold,
      color: gold,
      borderRadius: 3,
      fontWeight: 700,
    },
    parties: {
      flexDirection: 'row',
      marginBottom: 11,
    },
    partyCard: {
      flex: 1,
      padding: 9,
      borderWidth: 1,
      borderColor: line,
      backgroundColor: panel,
    },
    partyGap: { width: 10 },
    label: {
      fontSize: scale.small,
      color: gold,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 4,
    },
    customerName: { fontSize: scale.base + 1.5, fontWeight: 700, lineHeight: 1.25 },
    rowText: { fontSize: scale.small, color: muted, marginTop: 2 },
    table: { marginTop: 2, borderWidth: 1, borderColor: line },
    tableHead: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: line,
      backgroundColor: softGold,
      paddingVertical: 5,
      paddingHorizontal: 6,
    },
    th: { fontSize: scale.small, color: dark ? '#d9c47a' : '#6d5723', fontWeight: 700, textTransform: 'uppercase' },
    tableRow: {
      flexDirection: 'row',
      paddingVertical: scale.rowPad,
      paddingHorizontal: 6,
      borderBottomWidth: 0.5,
      borderBottomColor: line,
      minHeight: scale.base + scale.rowPad * 2 + 8,
    },
    colItem: { flex: 1.9, paddingRight: 8 },
    colQty: { width: 34, textAlign: 'right' },
    colUnit: { width: 64, textAlign: 'right' },
    colSub: { width: 74, textAlign: 'right' },
    itemTitle: { fontSize: scale.base, fontWeight: 600, lineHeight: 1.2 },
    itemMeta: { fontSize: scale.small, color: muted, marginTop: 1, lineHeight: 1.2 },
    bottomArea: { flexDirection: 'row', marginTop: 10 },
    paymentBox: {
      flex: 1,
      padding: 9,
      borderWidth: 1,
      borderColor: line,
      backgroundColor: panel,
      marginRight: 10,
    },
    summary: {
      width: 214,
      padding: 9,
      borderWidth: 1,
      borderColor: line,
      backgroundColor: panel,
    },
    sumRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 4,
      fontSize: scale.small,
    },
    grandRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 4,
      paddingTop: 6,
      borderTopWidth: 1,
      borderTopColor: line,
      fontSize: scale.base + 2,
      fontWeight: 700,
      color: gold,
    },
    payHead: { fontSize: scale.small, color: gold, fontWeight: 700, marginBottom: 5, textTransform: 'uppercase' },
    payRow: { flexDirection: 'row', fontSize: scale.small, paddingVertical: 2, borderBottomWidth: 0.5, borderBottomColor: line },
    payCol1: { flex: 1 },
    payCol2: { width: 56, textAlign: 'right' },
    payCol3: { width: 54, textAlign: 'right' },
    progressText: { fontSize: scale.small, color: muted, marginTop: 6 },
    progressBar: { height: 4, backgroundColor: dark ? '#252525' : '#e8e1d0', marginTop: 3, flexDirection: 'row' },
    progressFill: { height: 4, backgroundColor: gold },
    qrRow: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
    qrImg: { width: 42, height: 42, marginRight: 8 },
    footer: {
      marginTop: 'auto',
      paddingTop: 9,
      borderTopWidth: 1,
      borderTopColor: line,
    },
    footerText: { fontSize: scale.small - 0.25, color: muted, textAlign: 'center', lineHeight: 1.3 },
    continuationTitle: { fontSize: scale.base + 5, fontWeight: 700, color: gold, marginBottom: 8 },
    pageNumber: { fontSize: scale.small, color: muted, textAlign: 'right', marginTop: 6 },
  })
}

function Watermark({ model, styles: s }: { model: InvoicePdfModel; styles: ReturnType<typeof buildStyles> }) {
  if (model.branding.watermarkEnabled === false || !model.branding.logoDataUrl) return null
  return <Image src={model.branding.logoDataUrl} style={s.watermark} fixed />
}

function Header({ model, styles: s }: { model: InvoicePdfModel; styles: ReturnType<typeof buildStyles> }) {
  const initials = model.branding.companyName.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'AL'
  return (
    <View style={s.header} wrap={false}>
      <View style={s.brandRow}>
        <View style={s.logoBox}>
          {model.branding.logoDataUrl ? <Image src={model.branding.logoDataUrl} style={s.logo} /> : <Text style={s.logoFallback}>{initials}</Text>}
        </View>
        <View>
          <Text style={s.brandName}>{model.branding.companyName}</Text>
          {model.branding.tagline ? <Text style={s.brandTag}>{model.branding.tagline}</Text> : null}
        </View>
      </View>
      <View>
        <Text style={s.invTitle}>INVOICE</Text>
        <Text style={s.invMeta}>{model.invoiceId}</Text>
        <Text style={s.invMeta}>Issued {pdfDate(model.issueDate)}</Text>
        {model.dueDate ? <Text style={s.invMeta}>Due {pdfDate(model.dueDate)}</Text> : null}
        <Text style={s.statusPill}>{model.paymentStatus}</Text>
      </View>
    </View>
  )
}

function Parties({ model, styles: s }: { model: InvoicePdfModel; styles: ReturnType<typeof buildStyles> }) {
  return (
    <View style={s.parties} wrap={false}>
      <View style={s.partyCard}>
        <Text style={s.label}>Bill to</Text>
        <Text style={s.customerName}>{model.customer.name}</Text>
        {model.customer.company ? <Text style={s.rowText}>{model.customer.company}</Text> : null}
        {model.customer.phone ? <Text style={s.rowText}>{model.customer.phone}</Text> : null}
        {model.customer.email ? <Text style={s.rowText}>{model.customer.email}</Text> : null}
        {model.customer.address ? <Text style={s.rowText}>{model.customer.address}</Text> : null}
      </View>
      <View style={s.partyGap} />
      <View style={s.partyCard}>
        <Text style={s.label}>From</Text>
        <Text style={s.customerName}>{model.branding.companyName}</Text>
        {model.branding.phone ? <Text style={s.rowText}>{model.branding.phone}</Text> : null}
        {model.branding.email ? <Text style={s.rowText}>{model.branding.email}</Text> : null}
        {model.branding.website ? <Text style={s.rowText}>{model.branding.website}</Text> : null}
        {model.branding.address ? <Text style={s.rowText}>{model.branding.address}</Text> : null}
      </View>
    </View>
  )
}

function ItemsTable({
  model,
  rows,
  styles: s,
  continuation = false,
}: {
  model: InvoicePdfModel
  rows: InvoicePdfModel['lineItems']
  styles: ReturnType<typeof buildStyles>
  continuation?: boolean
}) {
  const scale = compactScale(model)
  return (
    <View style={s.table}>
      <View style={s.tableHead} wrap={false}>
        <Text style={[s.th, s.colItem]}>{continuation ? 'Item / Service continued' : 'Item / Service'}</Text>
        <Text style={[s.th, s.colQty]}>Qty</Text>
        <Text style={[s.th, s.colUnit]}>Unit</Text>
        <Text style={[s.th, s.colSub]}>Amount</Text>
      </View>
      {rows.map((item, i) => (
        <View key={`${item.description}-${i}`} style={s.tableRow} wrap={false}>
          <View style={s.colItem}>
            <Text style={s.itemTitle}>{item.description}</Text>
            {item.meta ? <Text style={s.itemMeta}>{item.meta}</Text> : null}
          </View>
          <Text style={[s.colQty, { fontSize: scale.base }]}>{item.qty}</Text>
          <Text style={[s.colUnit, { fontSize: scale.base }]}>{pdfMoney(item.unitPrice)}</Text>
          <Text style={[s.colSub, { fontSize: scale.base, fontWeight: 700 }]}>{pdfMoney(item.subtotal)}</Text>
        </View>
      ))}
    </View>
  )
}

function PaymentAndSummary({ model, styles: s }: { model: InvoicePdfModel; styles: ReturnType<typeof buildStyles> }) {
  const scale = compactScale(model)
  const payRows = model.payments.slice(0, scale.maxPayRows)
  return (
    <View style={s.bottomArea} wrap={false}>
      <View style={s.paymentBox}>
        <Text style={s.payHead}>Payment</Text>
        {payRows.length > 0 ? payRows.map((p, i) => (
          <View key={`${p.date}-${i}`} style={s.payRow}>
            <Text style={s.payCol1}>{pdfDate(p.date)} · {p.method}</Text>
            <Text style={s.payCol2}>{pdfMoney(p.amount)}</Text>
            <Text style={s.payCol3}>{p.note || ''}</Text>
          </View>
        )) : <Text style={s.rowText}>No payment has been recorded yet.</Text>}
        {model.total > 0 ? (
          <>
            <Text style={s.progressText}>Paid {model.paidPercentage}% · Due {pdfMoney(model.dueAmount)}</Text>
            <View style={s.progressBar}>
              <View style={[s.progressFill, { flex: Math.max(0.01, model.paidPercentage / 100) }]} />
              <View style={{ flex: Math.max(0.01, (100 - model.paidPercentage) / 100) }} />
            </View>
          </>
        ) : null}
        {model.qrDataUrl ? (
          <View style={s.qrRow}>
            <Image src={model.qrDataUrl} style={s.qrImg} />
            <Text style={s.rowText}>Scan to pay · {model.branding.phone || model.branding.email}</Text>
          </View>
        ) : null}
      </View>
      <View style={s.summary}>
        <View style={s.sumRow}><Text>Subtotal</Text><Text>{pdfMoney(model.subtotal)}</Text></View>
        {model.discount > 0 ? <View style={s.sumRow}><Text>Discount</Text><Text>-{pdfMoney(model.discount)}</Text></View> : null}
        {model.vat > 0 ? <View style={s.sumRow}><Text>VAT</Text><Text>{pdfMoney(model.vat)}</Text></View> : null}
        {model.shipping > 0 ? <View style={s.sumRow}><Text>Shipping</Text><Text>{pdfMoney(model.shipping)}</Text></View> : null}
        <View style={s.sumRow}><Text>Paid</Text><Text>{pdfMoney(model.totalPaid)}</Text></View>
        {model.dueAmount > 0 ? <View style={s.sumRow}><Text>Due</Text><Text>{pdfMoney(model.dueAmount)}</Text></View> : null}
        <View style={s.grandRow}><Text>Total</Text><Text>{pdfMoney(model.total)}</Text></View>
      </View>
    </View>
  )
}

function Footer({ model, styles: s }: { model: InvoicePdfModel; styles: ReturnType<typeof buildStyles> }) {
  return (
    <View style={s.footer} wrap={false}>
      {model.branding.footerThanks ? <Text style={s.footerText}>{model.branding.footerThanks}</Text> : null}
      {model.branding.footerPolicy ? <Text style={s.footerText}>{model.branding.footerPolicy}</Text> : null}
      {model.branding.footerNote ? <Text style={s.footerText}>{model.branding.footerNote}</Text> : null}
    </View>
  )
}

export function PremiumInvoiceDocument({ model }: { model: InvoicePdfModel }) {
  const s = buildStyles(model)
  const firstPageCapacity = model.payments.length > 4 ? 10 : MAX_FIRST_PAGE_ROWS
  const pages = chunkRows(model.lineItems, firstPageCapacity, MAX_CONTINUATION_ROWS)

  return (
    <Document title={model.invoiceId} author={model.branding.companyName} subject={`Invoice ${model.invoiceId}`}>
      <Page size={A4_SIZE} style={s.page}>
        <Watermark model={model} styles={s} />
        <Header model={model} styles={s} />
        <Parties model={model} styles={s} />
        <ItemsTable model={model} rows={pages[0] ?? []} styles={s} />
        {pages.length === 1 ? <PaymentAndSummary model={model} styles={s} /> : null}
        {pages.length === 1 ? <Footer model={model} styles={s} /> : <Text style={s.pageNumber}>Continued on page 2</Text>}
      </Page>

      {pages.slice(1).map((rows, pageIndex) => (
        <Page key={pageIndex} size={A4_SIZE} style={s.page}>
          <Watermark model={model} styles={s} />
          <Header model={model} styles={s} />
          <Text style={s.continuationTitle}>Invoice items continued</Text>
          <ItemsTable model={model} rows={rows} styles={s} continuation />
          {pageIndex === pages.length - 2 ? <PaymentAndSummary model={model} styles={s} /> : null}
          {pageIndex === pages.length - 2 ? <Footer model={model} styles={s} /> : <Text style={s.pageNumber}>Continued</Text>}
        </Page>
      ))}
    </Document>
  )
}
