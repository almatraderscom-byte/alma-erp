import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'

export type ArchiveVisibility = 'active' | 'archived' | 'all'

export function parseArchiveVisibility(raw: string | null | undefined): ArchiveVisibility {
  const v = String(raw || 'active').toLowerCase()
  if (v === 'archived' || v === 'archive') return 'archived'
  if (v === 'all') return 'all'
  return 'active'
}

/** Merge Prisma where clause for soft-archived rows (sync — use only when schema verified). */
export function archiveVisibilityWhere(
  visibility: ArchiveVisibility,
  base: Record<string, unknown> = {},
  schemaReady = true,
): Record<string, unknown> {
  if (!schemaReady) return base
  if (visibility === 'active') return { ...base, isArchived: false }
  if (visibility === 'archived') return { ...base, isArchived: true }
  return base
}

/** Safe async wrapper — never adds isArchived if migration not applied. */
export async function resolveArchiveVisibilityWhere(
  visibility: ArchiveVisibility,
  base: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const ready = await isBusinessArchiveSchemaReady()
  if (!ready) {
    if (visibility === 'archived') {
      return { ...base, id: '__archive_schema_unavailable__' }
    }
    return base
  }
  return archiveVisibilityWhere(visibility, base, true)
}

export function buildArchiveConfirmationPhrase(businessId: string, moduleKeys: string[]) {
  const mods = [...moduleKeys].map(m => m.toUpperCase()).sort().join('+')
  return `ARCHIVE ${businessId} ${mods}`
}
