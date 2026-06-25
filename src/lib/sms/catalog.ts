import type { BusinessId } from '@/lib/businesses'
import type { SmsType } from '@/lib/sms/types'

export const ALL_SMS_TYPES: SmsType[] = [
  'ORDER_CONFIRMATION',
  'INVOICE_READY',
  'COURIER_UPDATE',
  'TRADING_DAILY_SUMMARY',
  'SALARY_RECEIVED',
  'WALLET_WITHDRAWAL_APPROVED',
  'PAYROLL_ADVANCE_ALERT',
  'LOW_STOCK_ALERT',
  'TEST',
]

export const DEFAULT_SMS_ENABLED_TYPES: SmsType[] = [
  'ORDER_CONFIRMATION',
  'SALARY_RECEIVED',
  'WALLET_WITHDRAWAL_APPROVED',
]

export type SmsTypeCatalogItem = {
  type: SmsType
  label: string
  labelBn: string
  description: string
  audience: string
  suggestedBusiness: BusinessId | 'ANY'
  defaultEnabled: boolean
}

/** Client-safe catalog — no Prisma / server-only imports. */
export const SMS_TYPE_CATALOG: SmsTypeCatalogItem[] = [
  {
    type: 'ORDER_CONFIRMATION',
    label: 'Order confirmation',
    labelBn: 'অর্ডার কনফার্মেশন',
    description: 'Website বা ERP-তে নতুন order হলে customer-কে SMS',
    audience: 'Customer phone',
    suggestedBusiness: 'ALMA_LIFESTYLE',
    defaultEnabled: true,
  },
  {
    type: 'SALARY_RECEIVED',
    label: 'Salary credited',
    labelBn: 'বেতন জমা হয়েছে',
    description: 'মাসিক payroll accrual-এ employee wallet-এ টাকা গেলে',
    audience: 'Employee phone',
    suggestedBusiness: 'ANY',
    defaultEnabled: true,
  },
  {
    type: 'WALLET_WITHDRAWAL_APPROVED',
    label: 'Wallet withdrawal approved',
    labelBn: 'উইথড্র অনুমোদিত',
    description: 'Staff wallet withdrawal approve হলে transaction id সহ employee-কে',
    audience: 'Employee phone',
    suggestedBusiness: 'ANY',
    defaultEnabled: true,
  },
  {
    type: 'INVOICE_READY',
    label: 'Invoice ready',
    labelBn: 'ইনভয়েস প্রস্তুত',
    description: 'Invoice তৈরি/শেয়ার হলে customer-কে',
    audience: 'Customer phone',
    suggestedBusiness: 'ALMA_LIFESTYLE',
    defaultEnabled: false,
  },
  {
    type: 'COURIER_UPDATE',
    label: 'Courier / shipped',
    labelBn: 'কুরিয়ার আপডেট',
    description: 'Order shipped বা tracking update হলে customer-কে',
    audience: 'Customer phone',
    suggestedBusiness: 'ALMA_LIFESTYLE',
    defaultEnabled: false,
  },
  {
    type: 'TRADING_DAILY_SUMMARY',
    label: 'Trading daily summary',
    labelBn: 'ট্রেডিং দৈনিক সারাংশ',
    description: 'Alma Trading দিনের profit/loss summary',
    audience: 'Super Admin phone',
    suggestedBusiness: 'ALMA_TRADING',
    defaultEnabled: false,
  },
  {
    type: 'PAYROLL_ADVANCE_ALERT',
    label: 'Salary advance alert',
    labelBn: 'অগ্রিম বেতন অ্যালার্ট',
    description: 'কেউ salary advance request করলে owner-কে',
    audience: 'Super Admin phone',
    suggestedBusiness: 'ANY',
    defaultEnabled: false,
  },
  {
    type: 'LOW_STOCK_ALERT',
    label: 'Low stock alert',
    labelBn: 'লো স্টক অ্যালার্ট',
    description: 'Inventory কম বা শেষ হলে owner-কে',
    audience: 'Super Admin phone',
    suggestedBusiness: 'ALMA_LIFESTYLE',
    defaultEnabled: false,
  },
  {
    type: 'TEST',
    label: 'Test SMS',
    labelBn: 'টেস্ট SMS',
    description: 'Settings থেকে test message পাঠানোর জন্য',
    audience: 'আপনার দেওয়া নম্বর',
    suggestedBusiness: 'ANY',
    defaultEnabled: false,
  },
]

const SMS_TYPE_SET = new Set<SmsType>(ALL_SMS_TYPES)

export function defaultEnabledTypesJson() {
  return JSON.stringify(DEFAULT_SMS_ENABLED_TYPES)
}

export function parseEnabledTypesJson(raw: string | null | undefined): SmsType[] {
  if (!raw?.trim()) return [...DEFAULT_SMS_ENABLED_TYPES]
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_SMS_ENABLED_TYPES]
    return parsed.filter((t): t is SmsType => SMS_TYPE_SET.has(t as SmsType))
  } catch {
    return [...DEFAULT_SMS_ENABLED_TYPES]
  }
}

export function serializeEnabledTypes(types: SmsType[]): string {
  const unique = [...new Set(types.filter(t => SMS_TYPE_SET.has(t)))]
  return JSON.stringify(unique.length ? unique : DEFAULT_SMS_ENABLED_TYPES)
}
