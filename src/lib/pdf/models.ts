import type { Order } from '@/types'
import type { CditInvoice, CditPayment } from '@/types/cdit'
import type { BusinessBranding } from '@/types/branding'
import type { InvoicePdfModel, InvoicePdfBranding } from '@/lib/pdf/types'
import { brandingToPdf } from '@/lib/pdf/branding'

function paymentStatusFromAmounts(total: number, paid: number): InvoicePdfModel['paymentStatus'] {
  if (paid <= 0) return 'Unpaid'
  if (paid >= total - 0.001) return 'Paid'
  return 'Partial Paid'
}

export function orderToPdfModel(
  order: Order,
  branding: BusinessBranding,
  logoDataUrl?: string,
  invoiceId?: string,
): InvoicePdfModel {
  const subtotal = order.unit_price * order.qty
  const discount = order.discount + order.add_discount
  const total = order.sell_price + order.shipping_fee
  const totalPaid = total
  const b = brandingToPdf(branding, logoDataUrl)

  return {
    businessId: 'ALMA_LIFESTYLE',
    invoiceId: invoiceId || order.invoice_num || `AL-INV-${order.id}`,
    issueDate: order.date || new Date().toISOString().slice(0, 10),
    dueDate: order.actual_delivery || order.date || '',
    paymentStatus: paymentStatusFromAmounts(total, totalPaid),
    customer: {
      name: order.customer,
      phone: order.phone,
      address: order.address,
    },
    lineItems: [{
      description: order.product,
      meta: [order.category, order.size, order.sku].filter(Boolean).join(' · '),
      qty: order.qty,
      unitPrice: order.unit_price,
      subtotal,
    }],
    subtotal,
    discount,
    vat: 0,
    shipping: order.shipping_fee,
    total,
    totalPaid,
    dueAmount: Math.max(0, total - totalPaid),
    paidPercentage: total > 0 ? Math.round((totalPaid / total) * 1000) / 10 : 100,
    payments: totalPaid > 0 ? [{
      date: order.date,
      amount: totalPaid,
      method: order.payment || '—',
      note: 'Full payment',
    }] : [],
    branding: b,
    theme: 'dark',
    currencyLabel: '\u09F3',
  }
}

export function cditInvoiceToPdfModel(
  inv: CditInvoice,
  payments: CditPayment[],
  branding: BusinessBranding,
  logoDataUrl?: string,
): InvoicePdfModel {
  const b = brandingToPdf(branding, logoDataUrl)
  const invPayments = payments.filter(p => p.invoice_id === inv.id && p.payment_type === 'income')
  const totalPaid = inv.total_paid ?? invPayments.reduce((s, p) => s + p.amount, 0)
  const total = inv.amount
  const due = inv.due_amount ?? Math.max(0, total - totalPaid)
  const pct = total > 0 ? Math.round((totalPaid / total) * 1000) / 10 : 0

  return {
    businessId: 'CREATIVE_DIGITAL_IT',
    invoiceId: inv.id,
    issueDate: inv.issued_date || '',
    dueDate: inv.due_date || '',
    paymentStatus: inv.payment_status || paymentStatusFromAmounts(total, totalPaid),
    customer: {
      name: inv.client_name,
    },
    lineItems: [{
      description: inv.invoice_type === 'recurring' ? `Recurring — ${inv.recurring_interval || 'service'}` : 'Professional services',
      meta: inv.notes || undefined,
      qty: 1,
      unitPrice: total,
      subtotal: total,
    }],
    subtotal: total,
    discount: 0,
    vat: 0,
    shipping: 0,
    total,
    totalPaid,
    dueAmount: due,
    paidPercentage: pct,
    payments: invPayments.map(p => ({
      date: p.payment_date || p.date || '',
      amount: p.amount,
      method: p.payment_method || '—',
      note: p.note || p.notes,
    })),
    branding: b,
    theme: 'dark',
    currencyLabel: '\u09F3',
  }
}

export function compactScale(model: InvoicePdfModel): {
  base: number
  small: number
  rowPad: number
  maxPayRows: number
} {
  const rows = model.lineItems.length + model.payments.length
  if (rows > 10) return { base: 7, small: 6, rowPad: 3, maxPayRows: 3 }
  if (rows > 6) return { base: 7.5, small: 6.5, rowPad: 4, maxPayRows: 4 }
  return { base: 8.5, small: 7, rowPad: 5, maxPayRows: 5 }
}
