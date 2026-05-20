import { prisma } from '@/lib/prisma'

/** IDs archived via registry (GAS/external modules). */
export async function getArchivedRegistryIds(businessId: string, moduleKey: string) {
  const rows = await prisma.businessArchiveEntity.findMany({
    where: { businessId, moduleKey, isArchived: true },
    select: { entityId: true },
    take: 50_000,
  })
  return new Set(rows.map(r => r.entityId))
}

export function filterListByArchivedIds<T extends { id?: string; order_id?: string }>(
  items: T[],
  archivedIds: Set<string>,
  idField: keyof T = 'id',
): T[] {
  if (!archivedIds.size) return items
  return items.filter(item => {
    const id = String(item[idField] ?? item.order_id ?? '')
    return !archivedIds.has(id)
  })
}
