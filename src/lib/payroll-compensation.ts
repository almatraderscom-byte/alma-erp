import type { EmployeeLedgerEntryType, User } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { moneyDecimal, periodFromDate, signedAmount, WALLET_MANUAL_ENTRY_TYPES } from '@/lib/payroll-wallet'
import { notifyRole, notifyUser } from '@/lib/notifications'
import { logEvent, errorMeta } from '@/lib/logger'

const COMMISSION_SOURCE = 'order_commission'
const DEFAULT_LARGE_BONUS_THRESHOLD = 10000
const DEFAULT_ABNORMAL_PENALTY_THRESHOLD = 5000

type OrderLike = {
  id?: string
  business_id?: string
  handled_by?: string
  sell_price?: number
  total?: number
}

type CompensationInput = {
  employeeId: string
  businessId: string
  type: EmployeeLedgerEntryType
  amount: number
  note?: string
  effectiveDate?: Date
  periodYm?: string | null
  createdById?: string | null
  approvedById?: string | null
  source?: string
  sourceRef?: string
  /** For refunds/settlements: id of the original ledger entry being settled. */
  relatedEntryId?: string | null
}

export function isCompensationEntryType(type: EmployeeLedgerEntryType) {
  return WALLET_MANUAL_ENTRY_TYPES.includes(type)
}

export function isCreditCompensationType(type: EmployeeLedgerEntryType) {
  return ['COMMISSION', 'EID_BONUS', 'PERFORMANCE_BONUS', 'OVERTIME', 'REIMBURSEMENT'].includes(type)
}

export function isDebitCompensationType(type: EmployeeLedgerEntryType) {
  return ['MEAL_DEDUCTION', 'PENALTY', 'ADVANCE', 'WITHDRAWAL'].includes(type)
}

export async function getCompensationSetting(businessId: string) {
  const configuredDefault = Number(process.env.PAYROLL_FIXED_ORDER_COMMISSION || 0)
  return prisma.payrollCompensationSetting.upsert({
    where: { businessId },
    update: {},
    create: {
      businessId,
      fixedCommissionPerDeliveredOrder: moneyDecimal(configuredDefault),
      largeBonusAlertThreshold: moneyDecimal(DEFAULT_LARGE_BONUS_THRESHOLD),
      abnormalPenaltyAlertThreshold: moneyDecimal(DEFAULT_ABNORMAL_PENALTY_THRESHOLD),
    },
  })
}

export async function createCompensationLedgerEntry(
  input: CompensationInput,
  options?: { skipNotify?: boolean },
) {
  if (!input.employeeId.trim()) throw new Error('employeeId is required')
  if (!input.businessId.trim()) throw new Error('businessId is required')
  if (!isCompensationEntryType(input.type)) throw new Error('Unsupported compensation type')
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new Error('Non-zero amount is required')
  if (input.type !== 'ADJUSTMENT' && input.type !== 'COMMISSION' && input.amount < 0) {
    throw new Error(`${input.type} amount must be positive`)
  }

  const date = input.effectiveDate || new Date()
  const entry = await prisma.employeeLedgerEntry.create({
    data: {
      employeeId: input.employeeId,
      businessId: input.businessId,
      date,
      periodYm: input.type === 'SALARY_ACCRUAL' ? (input.periodYm || periodFromDate(date)) : input.periodYm || null,
      type: input.type,
      amount: moneyDecimal(input.amount),
      note: input.note?.slice(0, 800) || null,
      createdById: input.createdById || null,
      approvedById: input.approvedById || input.createdById || null,
      source: input.source || 'manual_entry',
      sourceRef: input.sourceRef || `manual:${crypto.randomUUID()}`,
      relatedEntryId: input.relatedEntryId || null,
    },
  })

  if (!options?.skipNotify) {
    await notifyForCompensation(entry.id, {
      employeeId: input.employeeId,
      businessId: input.businessId,
      type: input.type,
      amount: input.amount,
      note: input.note,
      createdById: input.createdById,
    })
  }
  return entry
}

async function notifyForCompensation(entryId: string, input: Omit<CompensationInput, 'effectiveDate' | 'source' | 'sourceRef'>) {
  const user = await prisma.user.findFirst({
    where: { employeeIdGas: input.employeeId, active: true },
    select: { id: true },
  })
  const movement = signedAmount(input.type, input.amount)
  const title = compensationTitle(input.type)
  await notifyUser({
    userId: user?.id,
    businessId: input.businessId,
    type: 'PAYROLL_ALERT',
    priority: input.type === 'PENALTY' ? 'HIGH' : 'NORMAL',
    title,
    message: `${title}: ${movement >= 0 ? '+' : '-'}৳ ${Math.abs(movement).toLocaleString('en-BD')}${input.note ? ` · ${input.note}` : ''}`,
    actionUrl: '/portal',
  })

  const setting = await getCompensationSetting(input.businessId)
  const amountAbs = Math.abs(input.amount)
  const alertSuperAdmin =
    (['EID_BONUS', 'PERFORMANCE_BONUS', 'OVERTIME', 'REIMBURSEMENT'].includes(input.type)
      && amountAbs >= Number(setting.largeBonusAlertThreshold))
    || (input.type === 'PENALTY' && amountAbs >= Number(setting.abnormalPenaltyAlertThreshold))

  if (alertSuperAdmin) {
    await notifyRole({
      role: 'SUPER_ADMIN',
      businessId: input.businessId,
      type: 'PAYROLL_ALERT',
      priority: 'HIGH',
      title: input.type === 'PENALTY' ? 'Abnormal payroll penalty' : 'Large compensation added',
      message: `${input.type.replace(/_/g, ' ')} posted for ${input.employeeId}: ৳ ${amountAbs.toLocaleString('en-BD')}`,
      actionUrl: '/payroll',
    })
  }

  logEvent('info', 'payroll.compensation_created', {
    entryId,
    employeeId: input.employeeId,
    businessId: input.businessId,
    type: input.type,
    amount: input.amount,
    createdById: input.createdById,
  })
}

function compensationTitle(type: EmployeeLedgerEntryType) {
  if (type === 'COMMISSION') return 'Commission added'
  if (type === 'EID_BONUS') return 'Eid bonus added'
  if (type === 'PERFORMANCE_BONUS') return 'Performance bonus added'
  if (type === 'OVERTIME') return 'Overtime approved'
  if (type === 'REIMBURSEMENT') return 'Reimbursement added'
  if (type === 'MEAL_DEDUCTION') return 'Meal deduction added'
  if (type === 'PENALTY') return 'Penalty added'
  if (type === 'WITHDRAWAL') return 'Payout processed'
  return 'Wallet ledger updated'
}

export async function handleOrderCommissionStatus(order: OrderLike, status: string, actorUserId?: string | null) {
  const orderId = String(order.id || '').trim()
  const businessId = String(order.business_id || 'ALMA_LIFESTYLE').trim()
  const statusKey = status.trim().toUpperCase().replace(/\s+/g, '_')
  if (!orderId) return { ok: false, skipped: 'missing_order_id' }

  if (statusKey === 'DELIVERED') {
    return createDeliveredOrderCommission(order, businessId, orderId, actorUserId)
  }
  if (['RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID', 'CANCELLED', 'CANCELED'].includes(statusKey)) {
    return reverseDeliveredOrderCommission(businessId, orderId, actorUserId)
  }
  return { ok: true, skipped: 'status_not_commissionable' }
}

async function createDeliveredOrderCommission(order: OrderLike, businessId: string, orderId: string, actorUserId?: string | null) {
  const setting = await getCompensationSetting(businessId)
  if (!setting.commissionEnabled) return { ok: true, skipped: 'commission_disabled' }
  const amount = Number(setting.fixedCommissionPerDeliveredOrder || 0)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: true, skipped: 'commission_not_configured' }

  const owner = await resolveOrderHandlerUser(order)
  if (!owner?.employeeIdGas) return { ok: true, skipped: 'commission_owner_not_linked' }

  try {
    const entry = await createCompensationLedgerEntry({
      employeeId: owner.employeeIdGas,
      businessId,
      type: 'COMMISSION',
      amount,
      note: `Delivered order commission · ${orderId}`,
      createdById: actorUserId || null,
      approvedById: actorUserId || null,
      source: COMMISSION_SOURCE,
      sourceRef: commissionSourceRef(businessId, orderId),
    })
    return { ok: true, entryId: entry.id, employeeId: owner.employeeIdGas, amount }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: true, skipped: 'commission_already_exists' }
    }
    logEvent('error', 'payroll.commission_create_failed', { ...errorMeta(e), businessId, orderId })
    throw e
  }
}

async function reverseDeliveredOrderCommission(businessId: string, orderId: string, actorUserId?: string | null) {
  const original = await prisma.employeeLedgerEntry.findUnique({
    where: { source_sourceRef: { source: COMMISSION_SOURCE, sourceRef: commissionSourceRef(businessId, orderId) } },
  })
  if (!original) return { ok: true, skipped: 'no_commission_to_reverse' }

  try {
    const reversal = await createCompensationLedgerEntry({
      employeeId: original.employeeId,
      businessId,
      type: 'COMMISSION',
      amount: -Math.abs(Number(original.amount || 0)),
      note: `Commission reversal · ${orderId}`,
      createdById: actorUserId || null,
      approvedById: actorUserId || null,
      source: COMMISSION_SOURCE,
      sourceRef: commissionReversalSourceRef(businessId, orderId),
    })
    await notifyRole({
      role: 'SUPER_ADMIN',
      businessId,
      type: 'PAYROLL_ALERT',
      priority: 'HIGH',
      title: 'Commission reversed',
      message: `Order ${orderId} commission was reversed for ${original.employeeId}.`,
      actionUrl: '/payroll',
    })
    return { ok: true, entryId: reversal.id, reversedEntryId: original.id }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: true, skipped: 'commission_reversal_already_exists' }
    }
    logEvent('error', 'payroll.commission_reverse_failed', { ...errorMeta(e), businessId, orderId })
    throw e
  }
}

export async function resolveOrderHandlerUser(order: OrderLike): Promise<Pick<User, 'id' | 'name' | 'email' | 'employeeIdGas'> | null> {
  const handledBy = String(order.handled_by || '').trim()
  if (!handledBy) return null
  const userIdMatch = handledBy.match(/\(([a-z0-9_-]{8,})\)$/i)?.[1]
  if (userIdMatch) {
    const user = await prisma.user.findFirst({
      where: { id: userIdMatch, active: true, employeeIdGas: { not: null } },
      select: { id: true, name: true, email: true, employeeIdGas: true },
    })
    if (user) return user
  }

  const needle = handledBy.toLowerCase()
  const users = await prisma.user.findMany({
    where: { active: true, employeeIdGas: { not: null } },
    select: { id: true, name: true, email: true, employeeIdGas: true },
  })
  return users.find(u => (
    u.employeeIdGas?.toLowerCase() === needle
    || u.email?.toLowerCase() === needle
    || u.name.toLowerCase() === needle
    || handledBy.includes(`(${u.id})`)
  )) || null
}

function commissionSourceRef(businessId: string, orderId: string) {
  return `order-commission:${businessId}:${orderId}`
}

function commissionReversalSourceRef(businessId: string, orderId: string) {
  return `order-commission-reversal:${businessId}:${orderId}`
}
