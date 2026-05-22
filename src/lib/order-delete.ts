import { prisma } from '@/lib/prisma'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'

/** Hide order from ERP lists via business archive registry (GAS row remains). */
export async function archiveOrderAfterDeleteApproval(input: {
  businessId: string
  orderId: string
  actorUserId: string
  reason?: string
}) {
  if (!(await isBusinessArchiveSchemaReady())) {
    throw new Error('Order archive registry is not available on this database.')
  }

  const now = new Date()
  const batch = await prisma.businessArchiveBatch.create({
    data: {
      name: `Order delete · ${input.orderId}`,
      businessId: input.businessId,
      moduleKeys: 'orders',
      status: 'COMPLETED',
      recordCount: 1,
      createdById: input.actorUserId,
      completedAt: now,
    },
  })

  await prisma.businessArchiveEntity.upsert({
    where: {
      businessId_moduleKey_entityId: {
        businessId: input.businessId,
        moduleKey: 'orders',
        entityId: input.orderId,
      },
    },
    create: {
      batchId: batch.id,
      businessId: input.businessId,
      moduleKey: 'orders',
      entityType: 'Order',
      entityId: input.orderId,
      archivedById: input.actorUserId,
      isArchived: true,
      archivedAt: now,
    },
    update: {
      batchId: batch.id,
      isArchived: true,
      archivedAt: now,
      archivedById: input.actorUserId,
      restoredAt: null,
      restoredById: null,
    },
  })

  return { batchId: batch.id, orderId: input.orderId, reason: input.reason || null }
}
