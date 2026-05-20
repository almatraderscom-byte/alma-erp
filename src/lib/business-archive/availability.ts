import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'

const CACHE_MS = 30_000
let cached: { at: number; ready: boolean } | null = null

function isMissingSchemaError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '')
  const code = String((err as { code?: string })?.code || '')
  return (
    code === 'P2021'
    || code === 'P2010'
    || code === '42P01'
    || msg.includes('does not exist')
    || msg.includes('BusinessArchiveEntity')
    || msg.includes('isArchived')
  )
}

/**
 * Returns true when business archive migration is applied (tables + soft-archive columns).
 * Cached briefly to avoid hammering information_schema on hot paths.
 */
export async function isBusinessArchiveSchemaReady(): Promise<boolean> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.ready

  try {
    await prisma.$queryRaw`SELECT 1 FROM "BusinessArchiveEntity" LIMIT 1`
    await prisma.$queryRaw`SELECT "isArchived" FROM "ApprovalRequest" LIMIT 0`
    cached = { at: Date.now(), ready: true }
    return true
  } catch (err) {
    logEvent('warn', 'businessArchive.schema_unavailable', {
      message: (err as Error).message,
      missing: isMissingSchemaError(err),
      hint: 'Run npm run db:migrate:deploy if tables are missing',
    })
    cached = { at: Date.now(), ready: false }
    return false
  }
}

export function clearArchiveSchemaCache() {
  cached = null
}
