import { StudioRunAuthorizationError } from '@/lib/creative-studio/studio-run-authorization'

// The real Prisma client and the behavioral test double both satisfy this
// intentionally narrow persistence boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StudioRunConfirmationDb = any

export type StudioQueuedJobRef = {
  pendingActionId: string
  label: string
  type?: string
}

export type StudioRunConfirmationReservation = {
  receiptId: string
  actorUserId: string
  idempotencyKey: string
  requestFingerprint: string
  selectionFingerprint: string
  estimateBdt: number
  maxCostBdt: number
}

export const STUDIO_RUN_CONFIRMATION_LEASE_MS = 2 * 60_000

export async function existingStudioReceiptJobs(
  db: StudioRunConfirmationDb,
  receiptId: string,
): Promise<Array<StudioQueuedJobRef & { type: 'image_gen' | 'video_gen' }>> {
  const rows = await db.agentPendingAction.findMany({
    where: { dedupeKey: { startsWith: `studio-run:${receiptId}:` } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, summary: true, type: true },
  })
  return (rows as Array<{ id: string; summary: string; type: string }>).map(
    (row) => ({
      pendingActionId: row.id,
      label: row.summary,
      type: row.type === 'video_gen' ? 'video_gen' : 'image_gen',
    }),
  )
}

async function studioConfirmationJobsById(
  db: StudioRunConfirmationDb,
  jobIds: string[],
): Promise<Array<StudioQueuedJobRef & { type: 'image_gen' | 'video_gen' }>> {
  if (!jobIds.length) return []
  const rows = await db.agentPendingAction.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, summary: true, type: true },
  }) as Array<{ id: string; summary: string; type: string }>
  const byId = new Map(rows.map((row) => [row.id, row]))
  return jobIds.flatMap((id) => {
    const row = byId.get(id)
    return row
      ? [{
          pendingActionId: row.id,
          label: row.summary,
          type: row.type === 'video_gen' ? 'video_gen' as const : 'image_gen' as const,
        }]
      : []
  })
}

export async function readStudioRunConfirmation(
  db: StudioRunConfirmationDb,
  receiptId: string,
): Promise<{ status: string; updatedAt: Date; jobIds: string[] } | null> {
  const row = await db.agentKvSetting.findUnique({
    where: { key: `studio_run_confirmation:${receiptId}` },
    select: { value: true, updatedAt: true },
  })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>
    return {
      status: String(parsed.status ?? ''),
      updatedAt: row.updatedAt,
      jobIds: Array.isArray(parsed.jobIds)
        ? parsed.jobIds.map(String).filter(Boolean)
        : [],
    }
  } catch {
    return { status: 'invalid', updatedAt: row.updatedAt, jobIds: [] }
  }
}

export async function reserveStudioRunConfirmation(
  db: StudioRunConfirmationDb,
  input: StudioRunConfirmationReservation,
  options: {
    now?: Date
    leaseMs?: number
  } = {},
): Promise<void> {
  const key = `studio_run_confirmation:${input.receiptId}`
  const now = options.now ?? new Date()
  const record = {
    version: 1,
    status: 'creating',
    ...input,
    reservedAt: now.toISOString(),
  }
  try {
    await db.agentKvSetting.create({
      data: { key, value: JSON.stringify(record) },
    })
    return
  } catch {
    const existing = await db.agentKvSetting.findUnique({
      where: { key },
      select: { value: true, updatedAt: true },
    })
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(String(existing?.value ?? '')) as Record<string, unknown>
    } catch {
      throw new StudioRunAuthorizationError(
        'run_confirmation_record_invalid',
        409,
      )
    }
    if (
      parsed.receiptId !== input.receiptId
      || parsed.actorUserId !== input.actorUserId
      || parsed.idempotencyKey !== input.idempotencyKey
      || parsed.requestFingerprint !== input.requestFingerprint
      || parsed.selectionFingerprint !== input.selectionFingerprint
      || Number(parsed.estimateBdt) !== input.estimateBdt
      || Number(parsed.maxCostBdt) !== input.maxCostBdt
    ) {
      throw new StudioRunAuthorizationError(
        'run_confirmation_replay_mismatch',
        409,
      )
    }
    const updatedAt = existing?.updatedAt instanceof Date
      ? existing.updatedAt.getTime()
      : Date.parse(String(existing?.updatedAt ?? ''))
    if (
      parsed.status === 'creating'
      && now.getTime() - updatedAt
        < (options.leaseMs ?? STUDIO_RUN_CONFIRMATION_LEASE_MS)
    ) {
      throw new StudioRunAuthorizationError(
        'run_confirmation_in_progress',
        425,
      )
    }
    if (parsed.status === 'queued') {
      throw new StudioRunAuthorizationError(
        'run_confirmation_jobs_unavailable',
        409,
      )
    }
    await db.agentKvSetting.update({
      where: { key },
      data: { value: JSON.stringify(record) },
    })
  }
}

export async function completeStudioRunConfirmation(
  db: StudioRunConfirmationDb,
  receiptId: string,
  jobs: StudioQueuedJobRef[],
): Promise<void> {
  const key = `studio_run_confirmation:${receiptId}`
  const row = await db.agentKvSetting.findUnique({
    where: { key },
    select: { value: true },
  })
  if (!row?.value) {
    throw new StudioRunAuthorizationError(
      'run_confirmation_record_missing',
      409,
    )
  }
  let record: Record<string, unknown>
  try {
    record = JSON.parse(row.value) as Record<string, unknown>
  } catch {
    throw new StudioRunAuthorizationError(
      'run_confirmation_record_invalid',
      409,
    )
  }
  await db.agentKvSetting.update({
    where: { key },
    data: {
      value: JSON.stringify({
        ...record,
        status: 'queued',
        queuedAt: new Date().toISOString(),
        jobIds: jobs.map((job) => job.pendingActionId),
      }),
    },
  })
}

/**
 * Durable receipt state machine. A queued replay returns only the exact stored
 * initial manifest (later chain jobs share the receipt prefix but are not part
 * of the confirmation response). A stale `creating` lease deliberately reruns
 * receipt-indexed constructors; each constructor reuses an existing row's
 * exact signed payload and creates only genuinely missing manifest entries.
 */
export async function executeStudioRunConfirmation<
  Result extends { jobs: StudioQueuedJobRef[] },
>(input: {
  db: StudioRunConfirmationDb
  reservation: StudioRunConfirmationReservation
  createJobs: () => Promise<Result>
  now?: Date
  leaseMs?: number
}): Promise<
  | { idempotent: true; jobs: Awaited<ReturnType<typeof existingStudioReceiptJobs>> }
  | { idempotent: false; jobs: Result['jobs']; result: Result }
> {
  const confirmation = await readStudioRunConfirmation(
    input.db,
    input.reservation.receiptId,
  )
  if (confirmation?.status === 'queued') {
    const replay = await studioConfirmationJobsById(
      input.db,
      confirmation.jobIds,
    )
    if (
      !confirmation.jobIds.length
      || replay.length !== confirmation.jobIds.length
    ) {
      throw new StudioRunAuthorizationError(
        'run_confirmation_jobs_unavailable',
        409,
      )
    }
    return { idempotent: true, jobs: replay }
  }
  await reserveStudioRunConfirmation(input.db, input.reservation, {
    now: input.now,
    leaseMs: input.leaseMs,
  })
  const result = await input.createJobs()
  await completeStudioRunConfirmation(
    input.db,
    input.reservation.receiptId,
    result.jobs,
  )
  return { idempotent: false, jobs: result.jobs, result }
}
