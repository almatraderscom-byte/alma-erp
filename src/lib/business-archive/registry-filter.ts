import { prisma } from '@/lib/prisma'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'

/** IDs archived via registry (GAS/external modules). Returns empty when schema unavailable. */
export async function getArchivedRegistryIds(businessId: string, moduleKey: string) {
  if (!(await isBusinessArchiveSchemaReady())) return new Set<string>()
  try {
    const rows = await prisma.businessArchiveEntity.findMany({
      where: { businessId, moduleKey, isArchived: true },
      select: { entityId: true },
      take: 50_000,
    })
    return new Set(rows.map(r => r.entityId))
  } catch {
    return new Set<string>()
  }
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
