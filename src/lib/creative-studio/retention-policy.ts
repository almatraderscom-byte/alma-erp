import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type StudioRetentionPolicy = {
  archiveEnabled: boolean
  deleteOriginalsEnabled: boolean
  retentionDays: number
  verificationGraceHours: number
}

export const DEFAULT_STUDIO_RETENTION_POLICY: StudioRetentionPolicy = {
  archiveEnabled: true,
  deleteOriginalsEnabled: true,
  retentionDays: 30,
  verificationGraceHours: 24,
}

export class RetentionPolicyError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 422) {
    super(code)
    this.name = 'RetentionPolicyError'
    this.code = code
    this.status = status
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RetentionPolicyError(code)
  }
  return parsed
}

export function normalizeStudioRetentionPolicy(
  value: Partial<StudioRetentionPolicy>,
  current: StudioRetentionPolicy = DEFAULT_STUDIO_RETENTION_POLICY,
): StudioRetentionPolicy {
  return {
    archiveEnabled: typeof value.archiveEnabled === 'boolean'
      ? value.archiveEnabled
      : current.archiveEnabled,
    deleteOriginalsEnabled: typeof value.deleteOriginalsEnabled === 'boolean'
      ? value.deleteOriginalsEnabled
      : current.deleteOriginalsEnabled,
    retentionDays: boundedInteger(
      value.retentionDays,
      current.retentionDays,
      7,
      3_650,
      'invalid_retention_days',
    ),
    verificationGraceHours: boundedInteger(
      value.verificationGraceHours,
      current.verificationGraceHours,
      1,
      168,
      'invalid_verification_grace_hours',
    ),
  }
}

export function retentionDeletionEligibility(input: {
  policy: StudioRetentionPolicy
  createdAt: Date
  verifiedAt: Date | null
  originalDeletedAt?: Date | null
  now: Date
}): { eligible: boolean; reason: string } {
  if (!input.policy.archiveEnabled) return { eligible: false, reason: 'archive_disabled' }
  if (!input.policy.deleteOriginalsEnabled) return { eligible: false, reason: 'deletion_disabled' }
  if (input.originalDeletedAt) return { eligible: false, reason: 'already_deleted' }
  if (!input.verifiedAt) return { eligible: false, reason: 'durable_verification_required' }
  const retentionAt = input.createdAt.getTime()
    + input.policy.retentionDays * 24 * 60 * 60_000
  if (input.now.getTime() < retentionAt) return { eligible: false, reason: 'retention_window_active' }
  const graceAt = input.verifiedAt.getTime()
    + input.policy.verificationGraceHours * 60 * 60_000
  if (input.now.getTime() < graceAt) return { eligible: false, reason: 'verification_grace_active' }
  return { eligible: true, reason: 'verified_archive_retention_elapsed' }
}

function serializePolicy(row: Record<string, unknown> | null): StudioRetentionPolicy {
  if (!row) return { ...DEFAULT_STUDIO_RETENTION_POLICY }
  return normalizeStudioRetentionPolicy({
    archiveEnabled: Boolean(row.archiveEnabled),
    deleteOriginalsEnabled: Boolean(row.deleteOriginalsEnabled),
    retentionDays: Number(row.retentionDays),
    verificationGraceHours: Number(row.verificationGraceHours),
  })
}

export async function getStudioRetentionPolicy(ownerId: string): Promise<StudioRetentionPolicy> {
  const row = await db.creativeRetentionPolicy.findUnique({ where: { ownerId } })
  return serializePolicy(row)
}

export async function saveStudioRetentionPolicy(
  ownerId: string,
  updatedById: string,
  value: Partial<StudioRetentionPolicy>,
): Promise<StudioRetentionPolicy> {
  const current = await getStudioRetentionPolicy(ownerId)
  const policy = normalizeStudioRetentionPolicy(value, current)
  const row = await db.creativeRetentionPolicy.upsert({
    where: { ownerId },
    create: {
      ownerId,
      updatedById,
      ...policy,
    },
    update: {
      updatedById,
      ...policy,
    },
  })
  return serializePolicy(row)
}

export async function getStudioRetentionDashboard(ownerId: string) {
  const policy = await getStudioRetentionPolicy(ownerId)
  const [
    total,
    verified,
    deleted,
    failed,
    oldestUnverified,
    lastRun,
  ] = await Promise.all([
    db.creativeArchiveReceipt.count(),
    db.creativeArchiveReceipt.count({ where: { verifiedAt: { not: null } } }),
    db.creativeArchiveReceipt.count({ where: { originalDeletedAt: { not: null } } }),
    db.creativeArchiveReceipt.count({ where: { lastErrorCode: { not: null } } }),
    db.creativeArchiveReceipt.findFirst({
      where: { verifiedAt: null },
      orderBy: { archivedAt: 'asc' },
      select: { archivedAt: true },
    }),
    db.agentKvSetting.findUnique({
      where: { key: 'studio_archive_last_run' },
      select: { value: true, updatedAt: true },
    }),
  ])
  const now = Date.now()
  return {
    policy,
    stats: {
      totalReceipts: Number(total),
      verifiedReceipts: Number(verified),
      deletedOriginals: Number(deleted),
      failedReceipts: Number(failed),
      oldestUnverifiedAgeHours: oldestUnverified
        ? Math.max(0, Math.round((now - new Date(oldestUnverified.archivedAt).getTime()) / 3_600_000))
        : 0,
      lastRun: lastRun
        ? {
            at: new Date(lastRun.updatedAt).toISOString(),
            detail: String(lastRun.value),
          }
        : null,
      ownerId,
    },
  }
}

export function retentionPolicyErrorResponse(error: unknown, event: string): Response {
  if (error instanceof RetentionPolicyError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status })
  }
  console.error(`[${event}] request failed`, error)
  return Response.json({ error: 'creative_retention_failed' }, { status: 500 })
}
