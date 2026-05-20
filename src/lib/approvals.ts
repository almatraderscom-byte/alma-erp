import { Prisma, type ApprovalRequest, type ApprovalStatus, type NotificationPriority } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createNotification } from '@/lib/notifications'
import { logEvent } from '@/lib/logger'
import type { ApprovalAuditEntry, ApprovalSource } from '@/lib/approval-types'
import { scheduleWorkflowTransitionNotification } from '@/lib/telegram-notification/lifecycle-transition'

export type ApprovalModule = 'ALMA_TRADING' | 'INVENTORY' | 'PAYROLL' | 'ORDERS_CRM'

import type { ApprovalTx } from '@/lib/prisma-transaction'

export type { ApprovalTx }

type CreateApprovalInput = {
  module: ApprovalModule
  type: string
  businessId?: string | null
  entityId: string
  requestedBy: string
  reason: string
  payloadSnapshot?: Record<string, unknown>
  priority?: NotificationPriority
  actionUrl?: string | null
  title?: string
  message?: string
}

export function parseAuditHistory(raw: unknown): ApprovalAuditEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(row => row && typeof row === 'object') as ApprovalAuditEntry[]
}

export function appendAuditHistory(
  raw: unknown,
  entry: ApprovalAuditEntry,
): Prisma.InputJsonValue {
  return [...parseAuditHistory(raw), entry] as Prisma.InputJsonValue
}

function audit(action: string, actorUserId: string, reason?: string, source?: ApprovalSource) {
  return [
    {
      action,
      actorUserId,
      reason: reason || null,
      source: source || 'erp',
      timestamp: new Date().toISOString(),
    },
  ] satisfies ApprovalAuditEntry[]
}

export function dispatchApprovalsUpdated() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('alma:approvals-updated'))
  }
}

export async function createApprovalRequest(
  input: CreateApprovalInput & { tx?: ApprovalTx; skipNotify?: boolean },
) {
  const db = input.tx || prisma
  const existing = await db.approvalRequest.findFirst({
    where: {
      module: input.module,
      type: input.type,
      entityId: input.entityId,
      status: 'PENDING',
    },
  })
  if (existing) return existing

  const approval = await db.approvalRequest.create({
    data: {
      module: input.module,
      type: input.type,
      businessId: input.businessId || null,
      entityId: input.entityId,
      requestedBy: input.requestedBy,
      reason: input.reason,
      payloadSnapshot: input.payloadSnapshot ? input.payloadSnapshot as Prisma.InputJsonObject : undefined,
      priority: input.priority || 'NORMAL',
      actionUrl: input.actionUrl || null,
      auditHistory: audit('REQUESTED', input.requestedBy, input.reason),
    },
  })

  if (!input.tx && !input.skipNotify) {
    await notifyApprovalSuperAdmins(approval, {
      title: input.title || 'Approval required',
      message: input.message || `${input.module} ${input.type} requires approval.`,
    })
    scheduleWorkflowTransitionNotification({
      approval,
      transition: 'PENDING',
      actorUserId: input.requestedBy,
      reason: input.reason,
    })
  }
  logEvent('info', 'approval.request.created', { approvalId: approval.id, module: approval.module, type: approval.type, entityId: approval.entityId })
  return approval
}

export async function resolveApprovalRequest(input: {
  module: ApprovalModule
  type: string
  entityId: string
  status: Extract<ApprovalStatus, 'APPROVED' | 'REJECTED'>
  actorUserId: string
  reason?: string
  source?: ApprovalSource
  tx?: ApprovalTx
}) {
  const db = input.tx || prisma
  const approval = await db.approvalRequest.findFirst({
    where: { module: input.module, type: input.type, entityId: input.entityId, status: 'PENDING' },
  })
  if (!approval) return null
  const updated = await resolveApprovalRecord({
    approval,
    status: input.status,
    actorUserId: input.actorUserId,
    reason: input.reason,
    source: input.source,
    tx: input.tx,
  })
  if (!input.tx) {
    await notifyApprovalResolved(updated, input.actorUserId, input.status, input.reason)
  }
  return updated
}

async function resolveApprovalRecord(input: {
  approval: ApprovalRequest
  status: Extract<ApprovalStatus, 'APPROVED' | 'REJECTED'>
  actorUserId: string
  reason?: string
  source?: ApprovalSource
  tx?: ApprovalTx
}) {
  const db = input.tx || prisma
  const now = new Date()
  const nextHistory = appendAuditHistory(input.approval.auditHistory, {
    action: input.status,
    actorUserId: input.actorUserId,
    reason: input.reason || null,
    source: input.source || 'erp',
    timestamp: now.toISOString(),
  })
  const updated = await db.approvalRequest.update({
    where: { id: input.approval.id },
    data: input.status === 'APPROVED'
      ? { status: 'APPROVED', approvedBy: input.actorUserId, approvedAt: now, auditHistory: nextHistory }
      : { status: 'REJECTED', rejectedBy: input.actorUserId, rejectedAt: now, auditHistory: nextHistory },
  })
  logEvent('info', 'approval.request.resolved', { approvalId: updated.id, status: input.status, actorUserId: input.actorUserId })
  return updated
}

export async function notifyApprovalResolved(
  approval: ApprovalRequest,
  actorUserId: string,
  status: Extract<ApprovalStatus, 'APPROVED' | 'REJECTED'>,
  reason?: string,
) {
  await createNotification({
    userId: approval.requestedBy,
    businessId: approval.businessId,
    type: 'ADMIN_ANNOUNCEMENT',
    priority: 'NORMAL',
    title: status === 'APPROVED' ? 'Approval request approved' : 'Approval request rejected',
    message: `${approval.module} ${approval.type} was ${status.toLowerCase()}.${reason ? ` Reason: ${reason}` : ''}`,
    actionUrl: approval.actionUrl || undefined,
    createdById: actorUserId,
    metadata: { approvalId: approval.id, module: approval.module, type: approval.type, status },
  })

  scheduleWorkflowTransitionNotification({
    approval,
    transition: status,
    actorUserId,
    reason,
  })
}

export async function resolveApprovalRequestById(input: {
  id: string
  status: Extract<ApprovalStatus, 'APPROVED' | 'REJECTED'>
  actorUserId: string
  reason?: string
  source?: ApprovalSource
  tx?: ApprovalTx
  skipRequesterNotification?: boolean
}) {
  const db = input.tx || prisma
  const approval = await db.approvalRequest.findUnique({ where: { id: input.id } })
  if (!approval || approval.status !== 'PENDING') return null
  const updated = await resolveApprovalRecord({
    approval,
    status: input.status,
    actorUserId: input.actorUserId,
    reason: input.reason,
    source: input.source,
    tx: input.tx,
  })
  if (!input.tx && !input.skipRequesterNotification) {
    await notifyApprovalResolved(updated, input.actorUserId, input.status, input.reason)
  }
  return updated
}

export async function notifyApprovalSuperAdmins(approval: ApprovalRequest, content: { title: string; message: string }) {
  const owners = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', active: true },
    select: { id: true },
  })
  await Promise.all(owners.map(owner => createNotification({
    userId: owner.id,
    businessId: approval.businessId,
    type: 'ADMIN_ANNOUNCEMENT',
    priority: approval.priority,
    title: content.title,
    message: content.message,
    actionUrl: approval.actionUrl || '/approvals',
    createdById: approval.requestedBy,
    metadata: {
      approvalId: approval.id,
      module: approval.module,
      type: approval.type,
      entityId: approval.entityId,
      status: approval.status,
    },
  })))
}
