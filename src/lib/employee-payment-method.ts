import type {
  EmployeePaymentMethod,
  EmployeePaymentMethodType,
  MobileMoneyProvider,
  PaymentAccountUsage,
  PaymentMethodStatus,
} from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { businessAllowed } from '@/lib/business-access'
import type { BusinessId } from '@/lib/businesses'

export const MAX_QR_BYTES = 400_000

export type PayoutSummary = {
  methodId: string | null
  label: string
  accountHolder: string | null
  accountNumber: string
  accountNumberMasked: string
  isVerified: boolean
  status: PaymentMethodStatus | 'MISSING'
  provider?: string | null
  usageType?: string | null
  bankName?: string | null
}

export function maskAccountNumber(raw: string, type?: EmployeePaymentMethodType): string {
  const digits = raw.replace(/\s/g, '')
  if (digits.length <= 4) return '****'
  if (type === 'BANK_ACCOUNT' || digits.length > 11) {
    return `${digits.slice(0, 4)}****${digits.slice(-4)}`
  }
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`
}

export function providerLabel(provider: MobileMoneyProvider | null | undefined): string {
  if (!provider) return ''
  const map: Record<MobileMoneyProvider, string> = {
    BKASH: 'bKash',
    NAGAD: 'Nagad',
    ROCKET: 'Rocket',
    OTHER: 'Mobile',
  }
  return map[provider] || provider
}

export function usageLabel(usage: PaymentAccountUsage | null | undefined): string {
  if (!usage) return ''
  return usage === 'BUSINESS' ? 'Business' : 'Personal'
}

export function methodDisplayLabel(m: Pick<
  EmployeePaymentMethod,
  'type' | 'provider' | 'usageType' | 'bankName'
>): string {
  if (m.type === 'BANK_ACCOUNT') {
    return m.bankName ? `Bank · ${m.bankName}` : 'Bank account'
  }
  const p = providerLabel(m.provider)
  const u = usageLabel(m.usageType)
  return [p, u].filter(Boolean).join(' ') || 'Mobile banking'
}

export function toPayoutSummary(
  m: EmployeePaymentMethod | null,
  options: { reveal?: boolean } = {},
): PayoutSummary {
  if (!m || m.isArchived || m.status === 'ARCHIVED') {
    return {
      methodId: null,
      label: 'No payout method',
      accountHolder: null,
      accountNumber: '—',
      accountNumberMasked: '—',
      isVerified: false,
      status: 'MISSING',
    }
  }
  const reveal = options.reveal === true
  return {
    methodId: m.id,
    label: methodDisplayLabel(m),
    accountHolder: m.accountHolderName,
    accountNumber: reveal ? m.accountNumber : maskAccountNumber(m.accountNumber, m.type),
    accountNumberMasked: maskAccountNumber(m.accountNumber, m.type),
    isVerified: m.isVerified,
    status: m.status,
    provider: m.provider,
    usageType: m.usageType,
    bankName: m.bankName,
  }
}

export function paymentMethodDto(
  m: EmployeePaymentMethod,
  options: { reveal?: boolean } = {},
) {
  const reveal = options.reveal === true
  return {
    id: m.id,
    userId: m.userId,
    businessId: m.businessId,
    type: m.type,
    provider: m.provider,
    usageType: m.usageType,
    accountHolderName: m.accountHolderName,
    accountNumber: reveal ? m.accountNumber : maskAccountNumber(m.accountNumber, m.type),
    accountNumberMasked: maskAccountNumber(m.accountNumber, m.type),
    bankName: m.bankName,
    branchName: m.branchName,
    routingNumber: m.routingNumber,
    hasQr: Boolean(m.qrImageUrl),
    isPrimary: m.isPrimary,
    isVerified: m.isVerified,
    verifiedAt: m.verifiedAt?.toISOString() ?? null,
    status: m.status,
    suspiciousNote: m.suspiciousNote,
    displayLabel: methodDisplayLabel(m),
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

export async function logPaymentMethodAudit(params: {
  paymentMethodId?: string | null
  userId: string
  businessId: string
  actorUserId: string
  action: string
  detail?: Record<string, unknown>
}) {
  await prisma.employeePaymentMethodAuditLog.create({
    data: {
      paymentMethodId: params.paymentMethodId ?? null,
      userId: params.userId,
      businessId: params.businessId,
      actorUserId: params.actorUserId,
      action: params.action,
      detailJson: params.detail ? JSON.stringify(params.detail).slice(0, 4000) : null,
    },
  })
  logEvent('info', 'employee_payment_method.audit', {
    action: params.action,
    userId: params.userId,
    paymentMethodId: params.paymentMethodId,
    actorUserId: params.actorUserId,
  })
}

export async function getPrimaryPaymentMethod(userId: string, businessId: string) {
  const primary = await prisma.employeePaymentMethod.findFirst({
    where: {
      userId,
      businessId,
      isArchived: false,
      status: 'ACTIVE',
      isPrimary: true,
    },
  })
  if (primary) return primary
  return prisma.employeePaymentMethod.findFirst({
    where: {
      userId,
      businessId,
      isArchived: false,
      status: 'ACTIVE',
    },
    orderBy: { updatedAt: 'desc' },
  })
}

export async function resolvePayoutForUser(userId: string, businessId: string, reveal = false) {
  const method = await getPrimaryPaymentMethod(userId, businessId)
  return toPayoutSummary(method, { reveal })
}

export async function resolvePayoutSummariesForUsers(
  userIds: string[],
  businessId: string,
  reveal = false,
): Promise<Map<string, PayoutSummary>> {
  const map = new Map<string, PayoutSummary>()
  if (!userIds.length) return map

  const methods = await prisma.employeePaymentMethod.findMany({
    where: {
      userId: { in: userIds },
      businessId,
      isArchived: false,
      status: { in: ['ACTIVE', 'SUSPICIOUS', 'DISABLED'] },
    },
    orderBy: [{ isPrimary: 'desc' }, { updatedAt: 'desc' }],
  })

  const byUser = new Map<string, EmployeePaymentMethod>()
  for (const m of methods) {
    if (!byUser.has(m.userId)) byUser.set(m.userId, m)
    else if (m.isPrimary && !byUser.get(m.userId)?.isPrimary) byUser.set(m.userId, m)
  }

  for (const uid of userIds) {
    map.set(uid, toPayoutSummary(byUser.get(uid) ?? null, { reveal }))
  }
  return map
}

export async function listPaymentMethodsForUser(
  userId: string,
  businessId: string,
  reveal: boolean,
) {
  const rows = await prisma.employeePaymentMethod.findMany({
    where: { userId, businessId, isArchived: false },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
  })
  return rows.map(r => paymentMethodDto(r, { reveal }))
}

export function assertBusinessScope(actorBusinessAccess: string, businessId: string) {
  if (!businessAllowed(actorBusinessAccess, businessId as BusinessId)) {
    throw new Error('Business not permitted for this account')
  }
}

export async function clearOtherPrimary(userId: string, businessId: string, exceptId?: string) {
  await prisma.employeePaymentMethod.updateMany({
    where: {
      userId,
      businessId,
      isArchived: false,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { isPrimary: false },
  })
}

export function validateQrImageUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  const v = url.trim()
  if (v.startsWith('http://') || v.startsWith('https://')) return v.slice(0, 2000)
  if (v.startsWith('data:image/') && v.length <= MAX_QR_BYTES) return v
  throw new Error('QR must be a valid image URL or a small data:image payload')
}

export function normalizeMobileNumber(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.length < 10 || d.length > 15) throw new Error('Enter a valid mobile account number (10–15 digits)')
  return d
}

export function normalizeBankAccount(raw: string): string {
  const v = raw.replace(/\s/g, '')
  if (v.length < 8 || v.length > 34) throw new Error('Enter a valid bank account number')
  return v
}
