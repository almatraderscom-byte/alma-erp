export type ArchiveVisibility = 'active' | 'archived' | 'all'

export function parseArchiveVisibility(raw: string | null | undefined): ArchiveVisibility {
  const v = String(raw || 'active').toLowerCase()
  if (v === 'archived' || v === 'archive') return 'archived'
  if (v === 'all') return 'all'
  return 'active'
}

/** Merge Prisma where clause for soft-archived rows. */
export function archiveVisibilityWhere(
  visibility: ArchiveVisibility,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  if (visibility === 'active') return { ...base, isArchived: false }
  if (visibility === 'archived') return { ...base, isArchived: true }
  return base
}

export function buildArchiveConfirmationPhrase(businessId: string, moduleKeys: string[]) {
  const mods = [...moduleKeys].map(m => m.toUpperCase()).sort().join('+')
  return `ARCHIVE ${businessId} ${mods}`
}
