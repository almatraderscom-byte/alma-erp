import type { InvoicePdfModel } from '@/lib/pdf/types'

function safeStr(v: unknown, fallback = ''): string {
  if (v == null) return fallback
  const s = String(v).trim()
  return s || fallback
}

function safeNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function safeDataUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('data:image/')) return url
  return undefined
}

/** Prevent react-pdf crashes from undefined / invalid model fields. */
export function sanitizePdfModel(model: InvoicePdfModel): InvoicePdfModel {
  const lineItems = (model.lineItems?.length ? model.lineItems : [{
    description: 'Invoice item',
    qty: 1,
    unitPrice: safeNum(model.total, 0),
    subtotal: safeNum(model.total, 0),
  }]).map(item => ({
    description: safeStr(item.description, 'Item'),
    meta: item.meta ? safeStr(item.meta) : undefined,
    qty: Math.max(1, safeNum(item.qty, 1)),
    unitPrice: safeNum(item.unitPrice, 0),
    subtotal: safeNum(item.subtotal, safeNum(item.unitPrice, 0) * Math.max(1, safeNum(item.qty, 1))),
  }))

  const subtotal = safeNum(model.subtotal, lineItems.reduce((s, i) => s + i.subtotal, 0))
  const total = safeNum(model.total, subtotal)
  const totalPaid = safeNum(model.totalPaid, 0)
  const dueAmount = safeNum(model.dueAmount, Math.max(0, total - totalPaid))

  return {
    ...model,
    invoiceId: safeStr(model.invoiceId, 'INVOICE'),
    issueDate: safeStr(model.issueDate, new Date().toISOString().slice(0, 10)),
    dueDate: model.dueDate ? safeStr(model.dueDate) : '',
    paymentStatus: model.paymentStatus || 'Unpaid',
    customer: {
      name: safeStr(model.customer?.name, 'Customer'),
      company: model.customer?.company ? safeStr(model.customer.company) : undefined,
      phone: model.customer?.phone ? safeStr(model.customer.phone) : undefined,
      email: model.customer?.email ? safeStr(model.customer.email) : undefined,
      address: model.customer?.address ? safeStr(model.customer.address) : undefined,
    },
    lineItems,
    subtotal,
    discount: safeNum(model.discount, 0),
    vat: safeNum(model.vat, 0),
    shipping: safeNum(model.shipping, 0),
    total,
    totalPaid,
    dueAmount,
    paidPercentage: total > 0 ? Math.min(100, Math.max(0, safeNum(model.paidPercentage, (totalPaid / total) * 100))) : 100,
    payments: (model.payments ?? []).map(p => ({
      date: safeStr(p.date, model.issueDate),
      amount: safeNum(p.amount, 0),
      method: safeStr(p.method, '—'),
      note: p.note ? safeStr(p.note) : undefined,
    })),
    branding: {
      ...model.branding,
      companyName: safeStr(model.branding?.companyName, 'Company'),
      tagline: safeStr(model.branding?.tagline),
      phone: safeStr(model.branding?.phone),
      email: safeStr(model.branding?.email),
      website: safeStr(model.branding?.website),
      address: safeStr(model.branding?.address),
      logoUrl: safeStr(model.branding?.logoUrl),
      logoDataUrl: safeDataUrl(model.branding?.logoDataUrl),
      colorPrimary: safeStr(model.branding?.colorPrimary, '#C9A84C'),
      colorSecondary: safeStr(model.branding?.colorSecondary, '#8B6914'),
      colorAccent: safeStr(model.branding?.colorAccent, '#F0D080'),
      footerThanks: safeStr(model.branding?.footerThanks),
      footerPolicy: safeStr(model.branding?.footerPolicy),
      footerNote: safeStr(model.branding?.footerNote),
    },
    qrDataUrl: safeDataUrl(model.qrDataUrl),
    theme: model.theme === 'light' ? 'light' : 'dark',
  }
}
