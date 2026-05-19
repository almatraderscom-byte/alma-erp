import { prisma } from '@/lib/prisma'

export async function logTelegramOpsAudit(input: {
  businessId: string
  eventType: string
  actorUserId?: string | null
  employeeId?: string | null
  attendanceRecordId?: string | null
  detail?: string | null
  metadata?: Record<string, unknown>
}) {
  return prisma.telegramOpsAuditLog.create({
    data: {
      businessId: input.businessId,
      eventType: input.eventType,
      actorUserId: input.actorUserId ?? null,
      employeeId: input.employeeId ?? null,
      attendanceRecordId: input.attendanceRecordId ?? null,
      detail: input.detail?.slice(0, 2000) ?? null,
      metadataJson: input.metadata ? JSON.stringify(input.metadata).slice(0, 8000) : null,
    },
  })
}
