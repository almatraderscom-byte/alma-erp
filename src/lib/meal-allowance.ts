import type { MealAllowanceProfile, MealAllowanceRequest } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import { createApprovalRequest, dispatchApprovalsUpdated, notifyApprovalResolved, resolveApprovalRequest } from '@/lib/approvals'
import { moneyDecimal } from '@/lib/payroll-wallet'
import { runApprovalTransaction } from '@/lib/prisma-transaction'
import { logEvent } from '@/lib/logger'

export type MealAllowanceEligibility = {
  enabled: boolean
  amountBdt: number | null
  canRequestToday: boolean
  pendingRequest: MealAllowanceRequest | null
  reason: string
}

export function startOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
}

export function formatAllowanceDateLabel(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export async function findMealAllowanceProfile(userId: string, businessId: string) {
  return prisma.mealAllowanceProfile.findUnique({
    where: { userId_businessId: { userId, businessId } },
  })
}

export async function getMealAllowanceEligibility(userId: string, businessId: string): Promise<MealAllowanceEligibility> {
  const profile = await findMealAllowanceProfile(userId, businessId)
  if (!profile?.enabled) {
    return {
      enabled: false,
      amountBdt: profile ? Number(profile.amountBdt) : null,
      canRequestToday: false,
      pendingRequest: null,
      reason: profile ? 'Meal allowance is not enabled for your account.' : 'Meal allowance is not configured for your account.',
    }
  }

  const dayStart = startOfUtcDay()
  const dayEnd = endOfUtcDay(dayStart)
  const blocking = await prisma.mealAllowanceRequest.findFirst({
    where: {
      userId,
      businessId,
      allowanceDate: { gte: dayStart, lt: dayEnd },
      status: { in: ['PENDING', 'APPROVED'] },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (blocking?.status === 'PENDING') {
    return {
      enabled: true,
      amountBdt: Number(profile.amountBdt),
      canRequestToday: false,
      pendingRequest: blocking,
      reason: 'You already have a pending meal allowance request for today.',
    }
  }

  if (blocking?.status === 'APPROVED') {
    return {
      enabled: true,
      amountBdt: Number(profile.amountBdt),
      canRequestToday: false,
      pendingRequest: blocking,
      reason: 'Meal allowance for today has already been approved.',
    }
  }

  return {
    enabled: true,
    amountBdt: Number(profile.amountBdt),
    canRequestToday: true,
    pendingRequest: null,
    reason: '',
  }
}

export async function assertCanCreateMealAllowanceRequest(
  userId: string,
  businessId: string,
  employeeId: string,
  allowanceDate: Date,
  reason: string,
) {
  const trimmedReason = reason.trim()
  if (!trimmedReason) throw new Error('reason is required')

  const profile = await findMealAllowanceProfile(userId, businessId)
  if (!profile?.enabled) throw new Error('Meal allowance is not enabled for your account.')
  if (Number(profile.amountBdt) <= 0) throw new Error('Meal allowance amount is not configured.')

  const dayStart = startOfUtcDay(allowanceDate)
  const dayEnd = endOfUtcDay(allowanceDate)
  const existing = await prisma.mealAllowanceRequest.findFirst({
    where: {
      userId,
      businessId,
      allowanceDate: { gte: dayStart, lt: dayEnd },
      status: { in: ['PENDING', 'APPROVED'] },
    },
  })
  if (existing) {
    throw new Error(
      existing.status === 'PENDING'
        ? 'A pending meal allowance request already exists for this date.'
        : 'Meal allowance for this date has already been approved.',
    )
  }

  return { profile, trimmedReason, employeeId: employeeId.trim() || profile.employeeId }
}

export async function createMealAllowanceRequest(input: {
  userId: string
  businessId: string
  employeeId: string
  amountBdt: number
  allowanceDate: Date
  reason: string
  userName?: string | null
}) {
  const { profile, trimmedReason, employeeId } = await assertCanCreateMealAllowanceRequest(
    input.userId,
    input.businessId,
    input.employeeId,
    input.allowanceDate,
    input.reason,
  )

  const request = await prisma.mealAllowanceRequest.create({
    data: {
      userId: input.userId,
      businessId: input.businessId,
      employeeId,
      allowanceDate: startOfUtcDay(input.allowanceDate),
      amountBdt: moneyDecimal(input.amountBdt || profile.amountBdt),
      reason: trimmedReason,
      status: 'PENDING',
    },
  })

  const amount = Number(request.amountBdt)
  const approval = await createApprovalRequest({
    module: APPROVAL_MODULES.PAYROLL,
    type: APPROVAL_TYPES.MEAL_ALLOWANCE,
    businessId: request.businessId,
    entityId: request.id,
    requestedBy: input.userId,
    reason: trimmedReason,
    priority: 'NORMAL',
    skipNotify: false,
    actionUrl: '/approvals',
    title: 'Meal allowance approval required',
    message: `${input.userName || employeeId}: ৳${amount.toLocaleString('en-BD')} · ${formatAllowanceDateLabel(request.allowanceDate)}`,
    payloadSnapshot: {
      userId: input.userId,
      employeeId: request.employeeId,
      amountBdt: amount,
      allowanceDate: request.allowanceDate.toISOString(),
      reason: trimmedReason,
      userName: input.userName || null,
    },
  })

  const linked = await prisma.mealAllowanceRequest.update({
    where: { id: request.id },
    data: { approvalId: approval.id },
  })

  return { request: linked, approval }
}

export async function processMealAllowanceApproval(
  approvalId: string,
  requestId: string,
  action: 'APPROVE' | 'REJECT',
  reviewerId: string,
  note?: string,
) {
  const request = await prisma.mealAllowanceRequest.findUnique({ where: { id: requestId } })
  if (!request) {
    const approval = await resolveApprovalRequest({
      module: APPROVAL_MODULES.PAYROLL,
      type: APPROVAL_TYPES.MEAL_ALLOWANCE,
      entityId: requestId,
      status: 'REJECTED',
      actorUserId: reviewerId,
      reason: note?.slice(0, 500) || 'Linked meal allowance request missing — approval auto-closed',
    })
    dispatchApprovalsUpdated()
    return {
      approval,
      request: null,
      ledgerEntry: null,
      reconciled: true,
      warning: 'Source meal allowance request was missing; approval closed to prevent orphan queue items.',
    }
  }

  if (request.status !== 'PENDING') {
    const terminal = request.status === 'APPROVED' ? 'APPROVED' : 'REJECTED'
    const approval = await resolveApprovalRequest({
      module: APPROVAL_MODULES.PAYROLL,
      type: APPROVAL_TYPES.MEAL_ALLOWANCE,
      entityId: request.id,
      status: terminal,
      actorUserId: reviewerId,
      reason: note?.slice(0, 500) || `Synced with request status ${request.status}`,
    })
    dispatchApprovalsUpdated()
    return {
      approval,
      request,
      ledgerEntry: request.ledgerEntryId
        ? await prisma.employeeLedgerEntry.findUnique({ where: { id: request.ledgerEntryId } })
        : null,
      reconciled: true,
    }
  }

  if (action === 'REJECT') {
    const result = await runApprovalTransaction('approval.meal_allowance_reject', async tx => {
      const updated = await tx.mealAllowanceRequest.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          reviewedById: reviewerId,
        },
      })
      const approval = await resolveApprovalRequest({
        module: APPROVAL_MODULES.PAYROLL,
        type: APPROVAL_TYPES.MEAL_ALLOWANCE,
        entityId: request.id,
        status: 'REJECTED',
        actorUserId: reviewerId,
        reason: note?.slice(0, 500) || 'Rejected',
        tx,
      })
      if (!approval) throw new Error('LINKAGE_BROKEN: pending approval row missing for meal allowance request')
      return { updated, approval }
    })

    logEvent('info', 'approval.meal_allowance_reject', { approvalId, requestId })
    if (result.approval) {
      await notifyApprovalResolved(result.approval, reviewerId, 'REJECTED', note?.slice(0, 500) || 'Rejected')
    }
    dispatchApprovalsUpdated()
    return { approval: result.approval, request: result.updated, ledgerEntry: null }
  }

  const result = await runApprovalTransaction('approval.meal_allowance_approve', async tx => {
    const entry = await tx.employeeLedgerEntry.create({
      data: {
        userId: request.userId,
        employeeId: request.employeeId,
        businessId: request.businessId,
        date: new Date(),
        type: 'MEAL_ALLOWANCE',
        amount: moneyDecimal(request.amountBdt),
        note: `Meal allowance - ${formatAllowanceDateLabel(request.allowanceDate)}`,
        createdById: request.userId,
        approvedById: reviewerId,
        source: 'meal_allowance',
        sourceRef: request.id,
      },
    })
    const updated = await tx.mealAllowanceRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        ledgerEntryId: entry.id,
        reviewedById: reviewerId,
      },
    })
    const approval = await resolveApprovalRequest({
      module: APPROVAL_MODULES.PAYROLL,
      type: APPROVAL_TYPES.MEAL_ALLOWANCE,
      entityId: request.id,
      status: 'APPROVED',
      actorUserId: reviewerId,
      reason: note?.slice(0, 500) || 'Approved',
      tx,
    })
    if (!approval) throw new Error('LINKAGE_BROKEN: pending approval row missing for meal allowance request')
    return { entry, updated, approval }
  })

  logEvent('info', 'approval.meal_allowance_approve', { approvalId, requestId, ledgerEntryId: result.entry.id })
  if (result.approval) {
    await notifyApprovalResolved(result.approval, reviewerId, 'APPROVED', note?.slice(0, 500) || 'Approved')
  }
  dispatchApprovalsUpdated()
  return { approval: result.approval, request: result.updated, ledgerEntry: result.entry }
}
