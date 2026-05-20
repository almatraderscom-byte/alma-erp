import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { buildArchiveConfirmationPhrase } from '@/lib/business-archive/query'
import {
  executeModuleArchive,
  isValidBusinessId,
  modulesForBusiness,
  previewArchive,
  restoreBatch,
  resolveModule,
} from '@/lib/business-archive/modules'

export async function logArchiveAudit(params: {
  batchId?: string | null
  businessId: string
  action: string
  actorUserId: string
  detail?: Record<string, unknown>
}) {
  await prisma.businessArchiveAuditLog.create({
    data: {
      batchId: params.batchId ?? null,
      businessId: params.businessId,
      action: params.action,
      actorUserId: params.actorUserId,
      detailJson: params.detail ? JSON.stringify(params.detail) : null,
    },
  })
  logEvent('info', 'businessArchive.audit', {
    businessId: params.businessId,
    action: params.action,
    batchId: params.batchId,
    userId: params.actorUserId,
  })
}

export async function runArchivePreview(businessId: string, moduleKeys: string[]) {
  if (!isValidBusinessId(businessId)) throw new Error('Invalid business')
  const allowed = new Set(modulesForBusiness(businessId).map(m => m.key))
  const keys = moduleKeys.filter(k => allowed.has(k))
  if (!keys.length) throw new Error('No valid modules selected')
  return previewArchive(businessId, keys)
}

export async function runArchiveExecute(params: {
  businessId: string
  moduleKeys: string[]
  batchName: string
  confirmation: string
  actorUserId: string
}) {
  const { businessId, moduleKeys, batchName, confirmation, actorUserId } = params
  if (!isValidBusinessId(businessId)) throw new Error('Invalid business')

  const allowed = new Set(modulesForBusiness(businessId).map(m => m.key))
  const keys = moduleKeys.filter(k => allowed.has(k))
  if (!keys.length) throw new Error('No valid modules selected')

  const expected = buildArchiveConfirmationPhrase(businessId, keys)
  if (confirmation.trim().toUpperCase() !== expected) {
    throw new Error(`Confirmation must be exactly: ${expected}`)
  }

  const preview = await previewArchive(businessId, keys)

  const batch = await prisma.businessArchiveBatch.create({
    data: {
      name: batchName.trim() || `Archive ${new Date().toISOString().slice(0, 10)}`,
      businessId,
      moduleKeys: keys.join(','),
      status: 'COMPLETED',
      recordCount: 0,
      dryRunSnapshot: JSON.stringify(preview),
      confirmationPhrase: expected,
      createdById: actorUserId,
      completedAt: new Date(),
    },
  })

  let total = 0
  for (const key of keys) {
    const count = await executeModuleArchive(key, businessId, batch.id, actorUserId)
    total += count
    await logArchiveAudit({
      batchId: batch.id,
      businessId,
      action: 'MODULE_ARCHIVED',
      actorUserId,
      detail: { moduleKey: key, count },
    })
  }

  await prisma.businessArchiveBatch.update({
    where: { id: batch.id },
    data: { recordCount: total },
  })

  await logArchiveAudit({
    batchId: batch.id,
    businessId,
    action: 'BATCH_COMPLETED',
    actorUserId,
    detail: { total, moduleKeys: keys },
  })

  return { batchId: batch.id, recordCount: total, preview }
}

export async function runArchiveRestore(batchId: string, actorUserId: string) {
  const batch = await prisma.businessArchiveBatch.findUnique({ where: { id: batchId } })
  if (!batch) throw new Error('Batch not found')
  const count = await restoreBatch(batchId, actorUserId)
  await logArchiveAudit({
    batchId,
    businessId: batch.businessId,
    action: 'BATCH_RESTORED',
    actorUserId,
    detail: { count },
  })
  return { restored: count }
}

export async function listArchiveBatches(businessId?: string) {
  const rows = await prisma.businessArchiveBatch.findMany({
    where: businessId ? { businessId } : {},
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      _count: { select: { entities: true } },
    },
  })
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    businessId: r.businessId,
    moduleKeys: r.moduleKeys.split(','),
    status: r.status,
    recordCount: r.recordCount,
    entityCount: r._count.entities,
    createdById: r.createdById,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    restoredAt: r.restoredAt?.toISOString() ?? null,
  }))
}

export async function listArchiveAudit(businessId: string, limit = 50) {
  const rows = await prisma.businessArchiveAuditLog.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  })
  return rows.map(r => ({
    id: r.id,
    batchId: r.batchId,
    action: r.action,
    actorUserId: r.actorUserId,
    detail: r.detailJson ? JSON.parse(r.detailJson) : null,
    createdAt: r.createdAt.toISOString(),
  }))
}

export { getArchiveStats, modulesForBusiness, resolveModule } from '@/lib/business-archive/modules'
