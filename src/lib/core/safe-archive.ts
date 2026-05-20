import { logEvent } from '@/lib/logger'
import {
  parseArchiveVisibility,
  resolveArchiveVisibilityWhere,
  archiveVisibilityWhere,
  type ArchiveVisibility,
} from '@/lib/business-archive/query'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'

export type { ArchiveVisibility }

export { parseArchiveVisibility, archiveVisibilityWhere }

/** Central archive filter — never throws; archived view empty when schema missing. */
export async function safeArchiveFilter(
  visibility: ArchiveVisibility,
  base: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  try {
    return await resolveArchiveVisibilityWhere(visibility, base)
  } catch (err) {
    logEvent('warn', 'archive.filter.failed', {
      visibility,
      message: (err as Error).message,
    })
    if (visibility === 'archived') {
      return { ...base, id: '__archive_filter_unavailable__' }
    }
    return base
  }
}

export async function safeArchiveSchemaReady(): Promise<boolean> {
  try {
    return await isBusinessArchiveSchemaReady()
  } catch {
    return false
  }
}
