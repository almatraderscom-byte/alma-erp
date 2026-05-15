import {
  Document, Page, View, Text, Image, StyleSheet,
} from '@react-pdf/renderer'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import { compactScale } from '@/lib/pdf/models'
import { pdfMoney, pdfDate } from '@/lib/pdf/format'
import { A4_SIZE, A4_WIDTH_PT, A4_HEIGHT_PT, A4_PADDING_PT } from '@/lib/pdf/a4'
import { getPdfFontFamily } from '@/lib/pdf/fonts'

function buildStyles(model: InvoicePdfModel) {
  const scale = compactScale(model)
  const dark = model.theme === 'dark'
  const bg = dark ? '#0a0a0c' : '#ffffff'
  const text = dark ? '#f2f0ea' : '#1a1a1a'
  const muted = dark ? '#9a968c' : '#666666'
  const gold = model.branding.colorPrimary
  const line = dark ? 'rgba(201,168,76,0.22)' : 'rgba(201,168,76,0.35)'

  return StyleSheet.create({
    page: {
      width: A4_WIDTH_PT,
      height: A4_HEIGHT_PT,
      backgroundColor: bg,
      color: text,
      paddingTop: A4_PADDING_PT.top,
      paddingBottom: A4_PADDING_PT.bottom,
      paddingHorizontal: A4_PADDING_PT.horizontal,
      fontFamily: getPdfFontFamily(),
      fontSize: scale.base,
    },
    pageInner: {
      flex: 1,
      flexDirection: 'column',
    },
    watermark: {
      position: 'absolute',
      top: '42%',
      left: '18%',
      fontSize: 48,
      color: gold,
      opacity: 0.08,
      transform: 'rotate(-24deg)',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 14,
      paddingBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: line,
    },
    logo: { width: 72, height: 36, objectFit: 'contain' as const },
    brandName: { fontSize: scale.base + 4, fontWeight: 700, color: gold, letterSpacing: 1 },
    brandTag: { fontSize: scale.small, color: muted, marginTop: 2 },
    invTitle: { fontSize: scale.base + 6, fontWeight: 700, textAlign: 'right' },
    invMeta: { fontSize: scale.small, color: muted, textAlign: 'right', marginTop: 2 },
    statusPill: {
      marginTop: 6,
      alignSelf: 'flex-end',
      fontSize: scale.small,
      paddingVertical: 2,
      paddingHorizontal: 8,
      backgroundColor: dark ? 'rgba(201,168,76,0.15)' : 'rgba(201,168,76,0.12)',
      color: gold,
      borderRadius: 4,
    },
    grid2: { flexDirection: 'row', gap: 16, marginBottom: 12 },
    block: { flex: 1 },
    label: { fontSize: scale.small, color: muted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
    customerName: { fontSize: scale.base + 1, fontWeight: 700 },
    rowText: { fontSize: scale.small, color: muted, marginTop: 2 },
    tableHead: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: line,
      paddingBottom: 4,
      marginBottom: 2,
    },
    th: { fontSize: scale.small, color: muted, fontWeight: 700, textTransform: 'uppercase' },
    tableRow: { flexDirection: 'row', paddingVertical: scale.rowPad, borderBottomWidth: 0.5, borderBottomColor: line },
    colItem: { flex: 3 },
    colQty: { width: 36, textAlign: 'right' },
    colUnit: { width: 64, textAlign: 'right' },
    colSub: { width: 72, textAlign: 'right', fontWeight: 700 },
    itemTitle: { fontSize: scale.base, fontWeight: 600 },
    itemMeta: { fontSize: scale.small, color: muted, marginTop: 1 },
    summaryWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8, marginBottom: 8 },
    summary: { width: 200 },
    sumRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3, fontSize: scale.small },
    grandRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 6,
      paddingTop: 6,
      borderTopWidth: 1,
      borderTopColor: line,
      fontSize: scale.base + 2,
      fontWeight: 700,
      color: gold,
    },
    progressBar: {
      height: 4,
      backgroundColor: dark ? '#222' : '#eee',
      borderRadius: 2,
      marginTop: 4,
      marginBottom: 8,
    },
    progressFill: { height: 4, backgroundColor: gold, borderRadius: 2 },
    paySection: { marginTop: 6 },
    payHead: { fontSize: scale.small, color: gold, fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' },
    payRow: { flexDirection: 'row', fontSize: scale.small, paddingVertical: 2, borderBottomWidth: 0.5, borderBottomColor: line },
    payCol1: { flex: 1 },
    payCol2: { width: 56, textAlign: 'right' },
    payCol3: { width: 72, textAlign: 'right' },
    qrRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: line },
    qrImg: { width: 48, height: 48 },
    footer: { marginTop: 'auto', paddingTop: 10, borderTopWidth: 1, borderTopColor: line },
    footerText: { fontSize: scale.small - 0.5, color: muted, textAlign: 'center', lineHeight: 1.35 },
  })
}

export function PremiumInvoiceDocument({ model }: { model: InvoicePdfModel }) {
  const s = buildStyles(model)
  const scale = compactScale(model)
  const payRows = model.payments.slice(0, scale.maxPayRows)
  const wm = model.paymentStatus === 'Paid' ? 'PAID' : model.paymentStatus === 'Unpaid' && model.dueDate ? 'DUE' : ''

  return (
    <Document title={model.invoiceId}>
      <Page size={A4_SIZE} style={s.page} wrap={false}>
        <View style={s.pageInner}>
        {wm ? <Text style={s.watermark}>{wm}</Text> : null}

        <View style={s.header}>
          <View style={{ flex: 1 }}>
            {model.branding.logoDataUrl ? (
              <Image src={model.branding.logoDataUrl} style={s.logo} />
            ) : null}
            <Text style={s.brandName}>{model.branding.companyName}</Text>
            {model.branding.tagline ? <Text style={s.brandTag}>{model.branding.tagline}</Text> : null}
          </View>
          <View>
            <Text style={s.invTitle}>INVOICE</Text>
            <Text style={s.invMeta}>{model.invoiceId}</Text>
            <Text style={s.invMeta}>Issued {pdfDate(model.issueDate)}</Text>
            {model.dueDate ? <Text style={s.invMeta}>Due {pdfDate(model.dueDate)}</Text> : null}
            <Text style={s.statusPill}>{model.paymentStatus}</Text>
          </View>
        </View>

        <View style={s.grid2}>
          <View style={s.block}>
            <Text style={s.label}>Bill to</Text>
            <Text style={s.customerName}>{model.customer.name}</Text>
            {model.customer.company ? <Text style={s.rowText}>{model.customer.company}</Text> : null}
            {model.customer.phone ? <Text style={s.rowText}>{model.customer.phone}</Text> : null}
            {model.customer.email ? <Text style={s.rowText}>{model.customer.email}</Text> : null}
            {model.customer.address ? <Text style={s.rowText}>{model.customer.address}</Text> : null}
          </View>
          <View style={s.block}>
            <Text style={s.label}>From</Text>
            <Text style={s.customerName}>{model.branding.companyName}</Text>
            {model.branding.phone ? <Text style={s.rowText}>{model.branding.phone}</Text> : null}
            {model.branding.email ? <Text style={s.rowText}>{model.branding.email}</Text> : null}
            {model.branding.address ? <Text style={s.rowText}>{model.branding.address}</Text> : null}
          </View>
        </View>

        <View style={s.tableHead}>
          <Text style={{ ...s.th, flex: 3 }}>Item / Service</Text>
          <Text style={{ ...s.th, width: 36, textAlign: 'right' }}>Qty</Text>
          <Text style={{ ...s.th, width: 64, textAlign: 'right' }}>Unit</Text>
          <Text style={{ ...s.th, width: 72, textAlign: 'right' }}>Amount</Text>
        </View>
        {model.lineItems.map((item, i) => (
          <View key={i} style={s.tableRow}>
            <View style={{ flex: 3 }}>
              <Text style={s.itemTitle}>{item.description}</Text>
              {item.meta ? <Text style={s.itemMeta}>{item.meta}</Text> : null}
            </View>
            <Text style={{ width: 36, textAlign: 'right', fontSize: scale.base }}>{item.qty}</Text>
            <Text style={{ width: 64, textAlign: 'right', fontSize: scale.base }}>{pdfMoney(item.unitPrice)}</Text>
            <Text style={{ width: 72, textAlign: 'right', fontSize: scale.base, fontWeight: 700 }}>{pdfMoney(item.subtotal)}</Text>
          </View>
        ))}

        <View style={s.summaryWrap}>
          <View style={s.summary}>
            <View style={s.sumRow}><Text>Subtotal</Text><Text>{pdfMoney(model.subtotal)}</Text></View>
            {model.discount > 0 && (
              <View style={s.sumRow}><Text>Discount</Text><Text>-{pdfMoney(model.discount)}</Text></View>
            )}
            {model.vat > 0 && (
              <View style={s.sumRow}><Text>VAT</Text><Text>{pdfMoney(model.vat)}</Text></View>
            )}
            {model.shipping > 0 && (
              <View style={s.sumRow}><Text>Shipping</Text><Text>{pdfMoney(model.shipping)}</Text></View>
            )}
            <View style={s.sumRow}><Text>Paid</Text><Text>{pdfMoney(model.totalPaid)}</Text></View>
            {model.dueAmount > 0 && (
              <View style={s.sumRow}><Text>Due</Text><Text>{pdfMoney(model.dueAmount)}</Text></View>
            )}
            <View style={s.grandRow}><Text>Total</Text><Text>{pdfMoney(model.total)}</Text></View>
          </View>
        </View>

        {model.total > 0 && (
          <View>
            <Text style={[s.label, { marginBottom: 2 }]}>Payment progress — {model.paidPercentage}%</Text>
            <View style={[s.progressBar, { flexDirection: 'row' }]}>
              <View style={[s.progressFill, { flex: Math.max(0.01, model.paidPercentage / 100) }]} />
              <View style={{ flex: Math.max(0.01, (100 - model.paidPercentage) / 100) }} />
            </View>
          </View>
        )}

        {payRows.length > 0 && (
          <View style={s.paySection}>
            <Text style={s.payHead}>Payment history</Text>
            {payRows.map((p, i) => (
              <View key={i} style={s.payRow}>
                <Text style={s.payCol1}>{pdfDate(p.date)} · {p.method}</Text>
                <Text style={s.payCol2}>{pdfMoney(p.amount)}</Text>
                <Text style={s.payCol3}>{p.note || ''}</Text>
              </View>
            ))}
          </View>
        )}

        {model.qrDataUrl ? (
          <View style={s.qrRow}>
            <Image src={model.qrDataUrl} style={s.qrImg} />
            <Text style={s.rowText}>Scan to pay · {model.branding.phone || model.branding.email}</Text>
          </View>
        ) : null}

        <View style={s.footer}>
          {model.branding.footerThanks ? <Text style={s.footerText}>{model.branding.footerThanks}</Text> : null}
          {model.branding.footerPolicy ? <Text style={s.footerText}>{model.branding.footerPolicy}</Text> : null}
          {model.branding.footerNote ? <Text style={s.footerText}>{model.branding.footerNote}</Text> : null}
        </View>
        </View>
      </Page>
    </Document>
  )
}
