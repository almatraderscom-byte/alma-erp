import React from 'react'
import {
  Document, Page, View, Text, Image, StyleSheet,
} from '@react-pdf/renderer'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import { compactScale } from '@/lib/pdf/models'
import { pdfMoney, pdfDate, type PdfCurrencyMode } from '@/lib/pdf/format'
import { A4_SIZE, A4_PADDING_PT, A4_WIDTH_PT, A4_HEIGHT_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'
import { FONT_STACK_PDF } from '@/lib/currency'
import {
  auraPalette,
  AuraBackdrop,
  AuraDocHeader,
  AuraSectionTitle,
  AuraFooter,
  auraTableStyles,
  type AuraPalette,
  type AuraBadgeTone,
} from '@/components/pdf/aura'

const MAX_FIRST_PAGE_ROWS = 12
const MAX_CONTINUATION_ROWS = 24
const WATERMARK_WIDTH = 450
const WATERMARK_HEIGHT = 180

function invoiceCurrencyMode(model: InvoicePdfModel): PdfCurrencyMode {
  return model.currencyLabel === 'symbol' || getPdfFontFamily() === FONT_STACK_PDF ? 'symbol' : 'bdt'
}

function invoiceMoney(model: InvoicePdfModel, n: number) {
  return pdfMoney(n, invoiceCurrencyMode(model))
}

function chunkRows<T>(rows: T[], firstPageMax: number, nextPageMax: number): T[][] {
  if (rows.length <= firstPageMax) return [rows]
  const pages = [rows.slice(0, firstPageMax)]
  for (let i = firstPageMax; i < rows.length; i += nextPageMax) {
    pages.push(rows.slice(i, i + nextPageMax))
  }
  return pages
}

function statusTone(status: InvoicePdfModel['paymentStatus']): AuraBadgeTone {
  if (status === 'Paid') return 'success'
  if (status === 'Partial Paid') return 'warning'
  return 'danger'
}

function buildStyles(model: InvoicePdfModel, p: AuraPalette) {
  const scale = compactScale(model)

  return StyleSheet.create({
    page: {
      backgroundColor: p.bg,
      color: p.ink,
      paddingTop: A4_PADDING_PT.top,
      paddingBottom: A4_PADDING_PT.bottom,
      paddingHorizontal: A4_PADDING_PT.horizontal,
      fontFamily: getPdfFontFamily(),
      fontSize: scale.base,
    },
    watermark: {
      position: 'absolute',
      left: (A4_WIDTH_PT - WATERMARK_WIDTH) / 2,
      top: (A4_HEIGHT_PT - WATERMARK_HEIGHT) / 2 + 12,
      width: WATERMARK_WIDTH,
      height: WATERMARK_HEIGHT,
      objectFit: 'contain' as const,
      opacity: model.branding.watermarkOpacity ?? 0.08,
    },
    parties: {
      flexDirection: 'row',
      marginBottom: 12,
    },
    partyCard: {
      flex: 1,
      padding: 10,
      borderWidth: 1,
      borderColor: p.line,
      borderRadius: 10,
      backgroundColor: p.panel,
    },
    partyGap: { width: 10 },
    label: {
      fontSize: scale.small,
      color: p.accent,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: 0.9,
      marginBottom: 4,
    },
    customerName: { fontSize: scale.base + 1.5, fontWeight: 700, lineHeight: 1.25, color: p.ink },
    rowText: { fontSize: scale.small, color: p.muted, marginTop: 2 },
    colItem: { flex: 1.9, paddingRight: 8 },
    colQty: { width: 34, textAlign: 'right' },
    colUnit: { width: 64, textAlign: 'right' },
    colSub: { width: 74, textAlign: 'right' },
    itemTitle: { fontSize: scale.base, fontWeight: 600, lineHeight: 1.2, color: p.ink },
    itemMeta: { fontSize: scale.small, color: p.muted, marginTop: 1, lineHeight: 1.2 },
    bottomArea: { flexDirection: 'row', alignItems: 'stretch', marginTop: 12 },
    paymentBox: {
      flex: 1,
      padding: 10,
      borderWidth: 1,
      borderColor: p.line,
      borderRadius: 10,
      backgroundColor: p.panel,
      marginRight: 10,
      minHeight: 118,
    },
    summary: {
      width: 214,
      padding: 10,
      borderWidth: 1,
      borderColor: p.line,
      borderRadius: 10,
      backgroundColor: p.panel,
      minHeight: 118,
    },
    sumRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 4,
      fontSize: scale.small,
      color: p.ink,
    },
    grandRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 5,
      padding: 6,
      backgroundColor: p.accentWash,
      borderRadius: 7,
      fontSize: scale.base + 2,
      fontWeight: 700,
      color: p.accent,
    },
    payHead: {
      fontSize: scale.small,
      color: p.accent,
      fontWeight: 700,
      marginBottom: 5,
      textTransform: 'uppercase',
      letterSpacing: 0.9,
    },
    payRow: {
      flexDirection: 'row',
      fontSize: scale.small,
      color: p.ink,
      paddingVertical: 2,
      borderBottomWidth: 0.5,
      borderBottomColor: p.lineSoft,
    },
    payCol1: { flex: 1 },
    payCol2: { width: 56, textAlign: 'right' },
    payCol3: { width: 54, textAlign: 'right' },
    progressText: { fontSize: scale.small, color: p.muted, marginTop: 6 },
    progressBar: {
      height: 5,
      backgroundColor: p.panel2,
      borderRadius: 999,
      marginTop: 3,
      flexDirection: 'row',
      borderWidth: 0.5,
      borderColor: p.lineSoft,
    },
    progressFill: { height: 4, backgroundColor: p.accent, borderRadius: 999 },
    qrRow: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
    qrImg: { width: 42, height: 42, marginRight: 8 },
  })
}

type Styles = ReturnType<typeof buildStyles>

function Watermark({ model, styles: s }: { model: InvoicePdfModel; styles: Styles }) {
  if (model.branding.watermarkEnabled === false || !model.branding.logoDataUrl) return null
  return <Image src={model.branding.logoDataUrl} style={s.watermark} fixed />
}

function Header({ model, p, continuation = false }: { model: InvoicePdfModel; p: AuraPalette; continuation?: boolean }) {
  const meta = continuation
    ? [model.invoiceId]
    : [
        model.invoiceId,
        `Issued ${pdfDate(model.issueDate)}`,
        ...(model.dueDate ? [`Due ${pdfDate(model.dueDate)}`] : []),
      ]
  return (
    <AuraDocHeader
      p={p}
      logoDataUrl={model.branding.logoDataUrl}
      companyName={model.branding.companyName}
      tagline={model.branding.tagline || undefined}
      docTitle="INVOICE"
      meta={meta}
      badge={{ tone: statusTone(model.paymentStatus), label: model.paymentStatus }}
    />
  )
}

function Parties({ model, styles: s }: { model: InvoicePdfModel; styles: Styles }) {
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
  p,
  rows,
  styles: s,
  continuation = false,
}: {
  model: InvoicePdfModel
  p: AuraPalette
  rows: InvoicePdfModel['lineItems']
  styles: Styles
  continuation?: boolean
}) {
  const scale = compactScale(model)
  const t = auraTableStyles(p)
  const rowDensity = {
    paddingVertical: scale.rowPad,
    minHeight: scale.base + scale.rowPad * 2 + 9,
  }
  return (
    <View style={t.container}>
      <View style={t.headRow} wrap={false}>
        <Text style={[t.th, s.colItem]}>{continuation ? 'Item / Service continued' : 'Item / Service'}</Text>
        <Text style={[t.th, s.colQty]}>Qty</Text>
        <Text style={[t.th, s.colUnit]}>Unit</Text>
        <Text style={[t.th, s.colSub]}>Amount</Text>
      </View>
      {rows.map((item, i) => (
        <View
          key={`${item.description}-${i}`}
          style={[
            t.row,
            rowDensity,
            ...(i % 2 === 1 ? [t.rowAlt] : []),
            ...(i === rows.length - 1 ? [t.lastRow] : []),
          ]}
          wrap={false}
        >
          <View style={s.colItem}>
            <Text style={s.itemTitle}>{item.description}</Text>
            {item.meta ? <Text style={s.itemMeta}>{item.meta}</Text> : null}
          </View>
          <Text style={[s.colQty, { fontSize: scale.base }]}>{item.qty}</Text>
          <Text style={[s.colUnit, { fontSize: scale.base }]}>{invoiceMoney(model, item.unitPrice)}</Text>
          <Text style={[s.colSub, { fontSize: scale.base, fontWeight: 700 }]}>{invoiceMoney(model, item.subtotal)}</Text>
        </View>
      ))}
    </View>
  )
}

function PaymentAndSummary({ model, styles: s }: { model: InvoicePdfModel; styles: Styles }) {
  const scale = compactScale(model)
  const payRows = model.payments.slice(0, scale.maxPayRows)
  return (
    <View style={s.bottomArea} wrap={false}>
      <View style={s.paymentBox}>
        <Text style={s.payHead}>Payment</Text>
        {payRows.length > 0 ? payRows.map((p, i) => (
          <View key={`${p.date}-${i}`} style={s.payRow}>
            <Text style={s.payCol1}>{pdfDate(p.date)} · {p.method}</Text>
            <Text style={s.payCol2}>{invoiceMoney(model, p.amount)}</Text>
            <Text style={s.payCol3}>{p.note || ''}</Text>
          </View>
        )) : <Text style={s.rowText}>No payment has been recorded yet.</Text>}
        {model.total > 0 ? (
          <>
            <Text style={s.progressText}>Paid {model.paidPercentage}% · Due {invoiceMoney(model, model.dueAmount)}</Text>
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
        <View style={s.sumRow}><Text>Subtotal</Text><Text>{invoiceMoney(model, model.subtotal)}</Text></View>
        {model.discount > 0 ? <View style={s.sumRow}><Text>Discount</Text><Text>-{invoiceMoney(model, model.discount)}</Text></View> : null}
        {model.vat > 0 ? <View style={s.sumRow}><Text>VAT</Text><Text>{invoiceMoney(model, model.vat)}</Text></View> : null}
        {model.shipping > 0 ? <View style={s.sumRow}><Text>Shipping</Text><Text>{invoiceMoney(model, model.shipping)}</Text></View> : null}
        <View style={s.sumRow}><Text>Paid</Text><Text>{invoiceMoney(model, model.totalPaid)}</Text></View>
        {model.dueAmount > 0 ? <View style={s.sumRow}><Text>Due</Text><Text>{invoiceMoney(model, model.dueAmount)}</Text></View> : null}
        <View style={s.grandRow}><Text>Total</Text><Text>{invoiceMoney(model, model.total)}</Text></View>
      </View>
    </View>
  )
}

function footerLines(model: InvoicePdfModel): string[] {
  return [
    model.branding.footerThanks || '',
    model.branding.footerPolicy || '',
    model.branding.footerNote || '',
  ]
}

export function PremiumInvoiceDocument({ model }: { model: InvoicePdfModel }) {
  const p = auraPalette(model.theme === 'dark' ? 'dark' : 'light', model.branding.colorPrimary || undefined)
  const s = buildStyles(model, p)
  const firstPageCapacity = model.payments.length > 4 ? 10 : MAX_FIRST_PAGE_ROWS
  const pages = chunkRows(model.lineItems, firstPageCapacity, MAX_CONTINUATION_ROWS)

  return (
    <Document title={model.invoiceId} author={model.branding.companyName} subject={`Invoice ${model.invoiceId}`}>
      <Page size={A4_SIZE} style={s.page}>
        <AuraBackdrop p={p} />
        <Watermark model={model} styles={s} />
        <Header model={model} p={p} />
        <Parties model={model} styles={s} />
        <ItemsTable model={model} p={p} rows={pages[0] ?? []} styles={s} />
        {pages.length === 1 ? <PaymentAndSummary model={model} styles={s} /> : null}
        {pages.length === 1
          ? <AuraFooter p={p} lines={footerLines(model)} />
          : <AuraFooter p={p} lines={[]} pageLabel="Continued on page 2" />}
      </Page>

      {pages.slice(1).map((rows, pageIndex) => (
        <Page key={pageIndex} size={A4_SIZE} style={s.page}>
          <AuraBackdrop p={p} />
          <Watermark model={model} styles={s} />
          <Header model={model} p={p} continuation />
          <AuraSectionTitle p={p}>Invoice items — continued</AuraSectionTitle>
          <ItemsTable model={model} p={p} rows={rows} styles={s} continuation />
          {pageIndex === pages.length - 2 ? <PaymentAndSummary model={model} styles={s} /> : null}
          {pageIndex === pages.length - 2
            ? <AuraFooter p={p} lines={footerLines(model)} />
            : <AuraFooter p={p} lines={[]} pageLabel="Continued" />}
        </Page>
      ))}
    </Document>
  )
}
