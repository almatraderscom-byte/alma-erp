import type { BusinessId } from '@/lib/businesses'
import type { CditPaymentStatus } from '@/types/cdit'

export type PdfTheme = 'dark' | 'light'

export interface InvoicePdfLineItem {
  description: string
  meta?: string
  qty: number
  unitPrice: number
  subtotal: number
}

export interface InvoicePdfPayment {
  date: string
  amount: number
  method: string
  note?: string
}

export interface InvoicePdfCustomer {
  name: string
  company?: string
  phone?: string
  email?: string
  address?: string
}

export interface InvoicePdfBranding {
  companyName: string
  tagline: string
  phone: string
  email: string
  website: string
  address: string
  facebook: string
  logoUrl?: string
  logoDataUrl?: string
  colorPrimary: string
  colorSecondary: string
  colorAccent: string
  footerThanks: string
  footerPolicy: string
  footerNote: string
}

export interface InvoicePdfModel {
  businessId: BusinessId
  invoiceId: string
  issueDate: string
  dueDate: string
  paymentStatus: CditPaymentStatus
  customer: InvoicePdfCustomer
  lineItems: InvoicePdfLineItem[]
  subtotal: number
  discount: number
  vat: number
  shipping: number
  total: number
  totalPaid: number
  dueAmount: number
  paidPercentage: number
  payments: InvoicePdfPayment[]
  branding: InvoicePdfBranding
  theme: PdfTheme
  currencyLabel?: string
  qrDataUrl?: string
}
