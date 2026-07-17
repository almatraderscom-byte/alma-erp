/**
 * VPS-handoff enqueue (Component A2).
 *
 * Genuinely long turns (> Vercel's 300s cap) are not run on the serverless
 * function at all — they are enqueued onto the SAME `long-agent-task` BullMQ
 * queue the VPS worker already drains. The worker runs the turn and republishes
 * its SSE events to Redis + the `agent_turn_events` log, which the client tails
 * via `/api/assistant/turn/:id/stream`.
 *
 * This module only ENQUEUES — it never executes a turn. Redis/BullMQ are imported
 * lazily so a missing REDIS_URL (or the absence of the worker) degrades to "no
 * handoff available" instead of crashing the route.
 */

export interface FileRefInput {
  bucket: string
  path: string
  mediaType: string
}

export interface TurnJobInput {
  conversationId?: string | null
  message?: string
  files?: FileRefInput[]
  projectId?: string | null
  personalMode?: boolean
  clientRequestId?: string | null
  /** AGENT-IOS-001 — tapped ask-card id; rides to the worker's internal chat call. */
  askCardId?: string | null
  internalControl?: boolean
}

export interface TurnJobData {
  turnId: string
  conversationId: string
  message: string
  files: FileRefInput[]
  projectId: string | null
  personalMode: boolean
  clientRequestId: string | null
  askCardId: string | null
  internalControl: boolean
}

/**
 * Pure builder — normalizes a request body + turnId into the job payload the
 * worker consumes. Kept side-effect free so it can be unit-tested without Redis.
 * Returns null when the inputs can't form a runnable turn (no turn id / no
 * conversation / empty message).
 */
export function buildTurnJobData(
  turnId: string | null,
  conversationId: string | null,
  body: TurnJobInput,
): TurnJobData | null {
  if (!turnId || !conversationId) return null
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return null
  const files: FileRefInput[] = Array.isArray(body.files)
    ? body.files.filter(
        (f): f is FileRefInput =>
          !!f && typeof f.path === 'string' && typeof f.mediaType === 'string' && typeof f.bucket === 'string',
      )
    : []
  return {
    turnId,
    conversationId,
    message,
    files,
    projectId: typeof body.projectId === 'string' ? body.projectId : null,
    personalMode: body.personalMode === true,
    clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : null,
    askCardId:
      typeof body.askCardId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.askCardId.trim())
        ? body.askCardId.trim()
        : null,
    internalControl: body.internalControl === true,
  }
}

/**
 * The Redis the A2 long-agent-task queue lives on. This MUST be the same cloud
 * Redis the VPS worker drains (it isolates long-task onto LONG_TASK_REDIS_URL),
 * so we read that var FIRST and fall back to REDIS_URL. Using the same precedence
 * on both sides means one env var name (LONG_TASK_REDIS_URL) configures A2
 * end-to-end — no silent mismatch where Vercel and the worker watch different Redis.
 */
function longTaskRedisUrl(): string | undefined {
  return process.env.LONG_TASK_REDIS_URL || process.env.REDIS_URL || undefined
}

/** True only when a VPS worker queue is reachable (cloud Redis configured). */
export function isTurnHandoffConfigured(): boolean {
  return Boolean(longTaskRedisUrl())
}

/**
 * Add the turn to the `long-agent-task` queue. Uses a deterministic jobId
 * (`turn-<turnId>`) so a double-submit can't enqueue the same turn twice.
 * NOTE: BullMQ forbids ':' in a custom job id ("Custom Id cannot contain :"), so
 * the separator is '-', not ':' — the old ':' silently failed EVERY enqueue
 * (the handoff fallback rarely fired, so it went unnoticed until the
 * approval-continuation path started relying on it).
 * Returns the job id, or null if no queue is configured / the add failed.
 */
export async function enqueueTurnJob(data: TurnJobData): Promise<string | null> {
  const url = longTaskRedisUrl()
  if (!url) return null
  try {
    const { Queue } = await import('bullmq')
    const queue = new Queue('long-agent-task', {
      connection: { url },
      defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } },
    })
    // attempts: 1 — a turn is NOT idempotent. A BullMQ retry (failure OR stall)
    // re-runs the ENTIRE agent turn from the original message: the owner sees the
    // whole research restart inside the same thread right after (or while) the
    // first run's work lands (owner bug 2026-07-12). If a turn dies, the durable
    // turn row goes 'error' and the owner re-asks — never a silent double-run.
    const job = await queue.add('turn', data, { jobId: `turn-${data.turnId}`, attempts: 1 })
    await queue.close()
    return job.id ?? null
  } catch (err) {
    console.warn('[turn-queue] enqueueTurnJob failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Phase 54 — durable task graph handoff ────────────────────────────────────

export interface DurableTaskJobData {
  workflowRunId: string
  graph: string
  conversationId: string | null
}

/** Pure builder for the durable-task job payload (unit-testable, no Redis). */
export function buildDurableTaskJobData(
  workflowRunId: string | null,
  graph: string | null,
  conversationId?: string | null,
): DurableTaskJobData | null {
  if (!workflowRunId || !graph) return null
  return { workflowRunId, graph, conversationId: conversationId ?? null }
}

/**
 * Enqueue a durable task graph run for VPS execution on the SAME
 * `long-agent-task` queue (job name 'durable-task'). UNLIKE turns, durable
 * tasks ARE safe to retry: every node checkpoints and effect nodes ride the
 * Phase 53 exactly-once engine — so BullMQ retries/stalls resume instead of
 * duplicating. Deterministic jobId prevents double-enqueue.
 */
export async function enqueueDurableTask(data: DurableTaskJobData): Promise<string | null> {
  const url = longTaskRedisUrl()
  if (!url) return null
  try {
    const { Queue } = await import('bullmq')
    const queue = new Queue('long-agent-task', {
      connection: { url },
      defaultJobOptions: {},
    })
    const job = await queue.add('durable-task', data, {
      jobId: `dtask-${data.workflowRunId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 15_000 },
    })
    await queue.close()
    return job.id ?? null
  } catch (err) {
    console.warn('[turn-queue] enqueueDurableTask failed:', err instanceof Error ? err.message : err)
    return null
  }
}
