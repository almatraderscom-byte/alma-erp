import type { ApprovalRequest, TelegramNotificationEventType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import {
  businessLabel,
  escapeHtml,
  erpBaseUrl,
  formatBdDate,
  formatBdTime,
} from '@/lib/telegram-notification/formatters'
import { withEmployeeAvatarMetadata } from '@/lib/telegram-notification/enqueue-metadata'
import { scheduleTelegramNotification } from '@/lib/telegram-notification/queue'
import { logTelegram } from '@/lib/telegram-notification/telegram-log'

export type WorkflowTransitionState =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'ROLLED_BACK'

const PENALTY_APPEAL_TYPES = new Set(['PENALTY_APPEAL'])
const SUBMIT_DEDUPED_EXTERNALLY = new Set([
  'PAYROLL:WALLET_WITHDRAWAL',
  'PAYROLL:WALLET_ADVANCE',
  'ALMA_TRADING:TRADE_DELETE',
])

type EnrichedContext = {
  employeeId?: string
  employeeName?: string
  userId?: string
  requestLabel: string
  amount?: number
  extraReason?: string
}

function workflowKey(approval: ApprovalRequest) {
  return `${approval.module}:${approval.type}`
}

function skipLifecycle(approval: ApprovalRequest, transition: WorkflowTransitionState) {
  if (PENALTY_APPEAL_TYPES.has(approval.type)) {
    logTransition('notification.transition.missing', {
      approvalId: approval.id,
      reason: 'penalty_appeal_handles_telegram',
      transition,
    })
    return true
  }
  if (transition === 'PENDING' && SUBMIT_DEDUPED_EXTERNALLY.has(workflowKey(approval))) {
    return true
  }
  return false
}

function eventTypeForTransition(
  transition: WorkflowTransitionState,
): TelegramNotificationEventType | null {
  if (transition === 'PENDING') return 'WORKFLOW_SUBMITTED'
  if (transition === 'APPROVED') return 'WORKFLOW_APPROVED'
  if (transition === 'REJECTED' || transition === 'CANCELLED') return 'WORKFLOW_REJECTED'
  if (transition === 'FAILED' || transition === 'ROLLED_BACK') return 'WORKFLOW_REJECTED'
  return null
}

function logTransition(
  event: string,
  meta: Record<string, unknown>,
  level: 'info' | 'warn' | 'error' = 'info',
) {
  logEvent(level, event, meta)
  logTelegram(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', event, meta)
}

async function loadActorName(actorUserId: string) {
  const user = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { name: true, email: true },
  })
  return user?.name || user?.email || 'Admin'
}

async function enrichApprovalContext(approval: ApprovalRequest): Promise<EnrichedContext> {
  const labelBase = approval.type.replace(/_/g, ' ')
  const key = workflowKey(approval)

  if (key === 'PAYROLL:WALLET_WITHDRAWAL' || key === 'PAYROLL:WALLET_ADVANCE') {
    const req = await prisma.walletRequest.findUnique({ where: { id: approval.entityId } })
    if (!req) {
      return { requestLabel: labelBase, extraReason: approval.reason }
    }
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, name: true, employeeIdGas: true },
    })
    const { resolvePayoutForUser } = await import('@/lib/employee-payment-method')
    const payout = await resolvePayoutForUser(req.userId, req.businessId, false)
    const typeLabel = req.type === 'WITHDRAWAL' ? 'Wallet withdrawal' : 'Salary advance (wallet)'
    const payoutNote =
      payout.status !== 'MISSING'
        ? `Preferred payout: ${payout.label} · ${payout.accountNumberMasked} (${payout.isVerified ? 'verified' : 'unverified'})`
        : 'Preferred payout: not on file'
    return {
      employeeId: req.employeeId,
      employeeName: user?.name || req.employeeId,
      userId: req.userId,
      requestLabel: typeLabel,
      amount: Number(req.requestedAmount),
      extraReason: `${req.reason}\n${payoutNote}`,
    }
  }

  if (key === 'PAYROLL:SALARY_ADVANCE') {
    const adv = await prisma.salaryAdvanceRequest.findUnique({
      where: { id: approval.entityId },
      include: { user: { select: { id: true, name: true, employeeIdGas: true } } },
    })
    if (!adv) return { requestLabel: 'Salary advance', extraReason: approval.reason }
    return {
      employeeId: adv.user.employeeIdGas || undefined,
      employeeName: adv.user.name || adv.userId,
      userId: adv.userId,
      requestLabel: 'Salary advance',
      amount: Number(adv.amount),
      extraReason: adv.reason,
    }
  }

  if (key === 'ALMA_TRADING:TRADE_DELETE') {
    const trade = await prisma.tradingTrade.findFirst({
      where: { id: approval.entityId },
      select: { tradingAccount: { select: { accountTitle: true } }, deleteReason: true, usdtAmount: true },
    })
    return {
      requestLabel: 'Trading delete',
      amount: trade ? Number(trade.usdtAmount) : undefined,
      extraReason: trade?.deleteReason || approval.reason,
      employeeName: trade?.tradingAccount?.accountTitle || approval.entityId,
    }
  }

  return {
    requestLabel: `${approval.module.replace(/_/g, ' ')} · ${labelBase}`,
    extraReason: approval.reason,
  }
}

function formatLifecycleMessage(input: {
  transition: WorkflowTransitionState
  ctx: EnrichedContext
  approval: ApprovalRequest
  actorName: string
  reason?: string
}) {
  const { transition, ctx, approval, actorName, reason } = input
  const biz = businessLabel(approval.businessId || 'ALMA_LIFESTYLE')
  const when = `${formatBdDate(new Date())} ${formatBdTime(new Date())}`
  const link = approval.actionUrl
    ? `${erpBaseUrl()}${approval.actionUrl.startsWith('/') ? approval.actionUrl : `/${approval.actionUrl}`}`
    : `${erpBaseUrl()}/approvals`

  const headline =
    transition === 'PENDING'
      ? '📥 <b>New approval request</b>'
      : transition === 'APPROVED'
        ? '✅ <b>Request approved</b>'
        : transition === 'REJECTED' || transition === 'CANCELLED'
          ? '❌ <b>Request rejected</b>'
          : '⚠️ <b>Request failed / rolled back</b>'

  const lines = [
    headline,
    '',
    `<b>Type:</b> ${escapeHtml(ctx.requestLabel)}`,
    `<b>Business:</b> ${escapeHtml(biz)}`,
  ]

  if (ctx.employeeName) {
    lines.push(`<b>Employee:</b> ${escapeHtml(ctx.employeeName)}`)
  }
  if (ctx.employeeId) {
    lines.push(`<b>HR ID:</b> <code>${escapeHtml(ctx.employeeId)}</code>`)
  }
  if (ctx.amount != null && Number.isFinite(ctx.amount)) {
    lines.push(`<b>Amount:</b> ৳ ${ctx.amount.toLocaleString('en-BD')}`)
  }

  const note = (reason || ctx.extraReason || approval.reason || '').trim()
  if (note) {
    lines.push(`<b>Reason:</b> ${escapeHtml(note.slice(0, 400))}`)
  }

  if (transition !== 'PENDING') {
    lines.push(`<b>Reviewed by:</b> ${escapeHtml(actorName)}`)
    lines.push(`<b>Time:</b> ${escapeHtml(when)}`)
  }

  lines.push('', `<a href="${link}">Open in ERP →</a>`)
  return lines.join('\n')
}

function dedupeKeyFor(
  approval: ApprovalRequest,
  transition: WorkflowTransitionState,
) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date())
  return `lifecycle:${approval.id}:${transition}:${day}`
}

/**
 * Central workflow lifecycle Telegram dispatcher.
 * Non-blocking — never throws to callers.
 */
export async function dispatchWorkflowTransitionNotification(input: {
  approval: ApprovalRequest
  transition: WorkflowTransitionState
  actorUserId: string
  reason?: string
}) {
  const { approval, transition, actorUserId, reason } = input

  logTransition('notification.transition.detected', {
    approvalId: approval.id,
    module: approval.module,
    type: approval.type,
    entityId: approval.entityId,
    oldState: approval.status,
    newState: transition,
    actorUserId,
  })

  if (!approval.businessId) {
    logTransition('notification.transition.missing', {
      approvalId: approval.id,
      reason: 'no_business_id',
      transition,
    }, 'warn')
    return { ok: false, skipped: 'NO_BUSINESS_ID' }
  }

  if (skipLifecycle(approval, transition)) {
    return { ok: false, skipped: 'HANDLED_ELSEWHERE' }
  }

  const eventType = eventTypeForTransition(transition)
  if (!eventType) {
    logTransition('notification.transition.missing', {
      approvalId: approval.id,
      reason: 'unsupported_transition',
      transition,
    }, 'warn')
    return { ok: false, skipped: 'UNSUPPORTED_TRANSITION' }
  }

  try {
    const [ctx, actorName] = await Promise.all([
      enrichApprovalContext(approval),
      transition === 'PENDING' ? Promise.resolve('System') : loadActorName(actorUserId),
    ])

    const message = formatLifecycleMessage({
      transition,
      ctx,
      approval,
      actorName,
      reason,
    })

    logTransition('notification.telegram.queued', {
      approvalId: approval.id,
      eventType,
      transition,
      entityType: workflowKey(approval),
    })

    scheduleTelegramNotification({
      businessId: approval.businessId,
      eventType,
      message,
      dedupeKey: dedupeKeyFor(approval, transition),
      metadata: withEmployeeAvatarMetadata(
        {
          approvalId: approval.id,
          entityId: approval.entityId,
          employeeId: ctx.employeeId,
          transition,
          workflowModule: approval.module,
          type: approval.type,
        },
        ctx.userId,
        ctx.employeeName,
      ),
    })

    return { ok: true }
  } catch (e) {
    logTransition('notification.telegram.failed', {
      approvalId: approval.id,
      transition,
      error: (e as Error).message,
    }, 'error')
    return { ok: false, error: (e as Error).message }
  }
}

export function scheduleWorkflowTransitionNotification(
  input: Parameters<typeof dispatchWorkflowTransitionNotification>[0],
) {
  void dispatchWorkflowTransitionNotification(input).catch(err => {
    logTransition('notification.telegram.failed', {
      approvalId: input.approval.id,
      transition: input.transition,
      error: (err as Error).message,
      phase: 'async_unhandled',
    }, 'error')
  })
}
