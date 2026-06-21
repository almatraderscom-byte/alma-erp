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
}

export interface TurnJobData {
  turnId: string
  conversationId: string
  message: string
  files: FileRefInput[]
  projectId: string | null
  personalMode: boolean
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
 * (`turn:<turnId>`) so a double-submit can't enqueue the same turn twice.
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
    const job = await queue.add('turn', data, { jobId: `turn:${data.turnId}` })
    await queue.close()
    return job.id ?? null
  } catch (err) {
    console.warn('[turn-queue] enqueueTurnJob failed:', err instanceof Error ? err.message : err)
    return null
  }
}
