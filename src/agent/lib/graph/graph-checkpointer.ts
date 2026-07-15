/**
 * LG-2 — durable LangGraph state on the EXISTING Supabase Postgres
 * (docs/langgraph-adoption-roadmap.md). One PostgresSaver singleton, tables in
 * the dedicated `langgraph` schema (created by the Prisma migration
 * 20260716020000_langgraph_checkpointer — PostgresSaver.setup() is never called
 * at runtime; the project's migration system is the single owner of DDL).
 *
 * Contract (non-negotiable rules):
 *  - Fail-open, always: every export resolves to null / no-op on any failure —
 *    a checkpointer problem must never kill chat. Callers compile their graph
 *    WITHOUT a checkpointer when this returns null.
 *  - Rollout gate mirrors LG-0/1: AGENT_LANGGRAPH_CHECKPOINT=true force-on,
 *    =false kill switch, default ON in Vercel preview / OFF in production.
 *  - Every gate decision + failure logs one line ("why didn't it checkpoint"
 *    must be answerable from runtime logs).
 *
 * Connection: DATABASE_URL (Supabase transaction pooler) — the saver only runs
 * parameterized DML, which pgbouncer transaction mode serves fine. Pool stays
 * tiny (max 2): this rides Vercel serverless functions next to Prisma's pool.
 */
import { Pool } from 'pg'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

const CHECKPOINT_SCHEMA = 'langgraph'

/** Stale threads are deleted after this many days (roadmap: cleanup from day 1). */
export const CHECKPOINT_TTL_DAYS = 14

/**
 * Rollout gate (state-router discipline, same shape as isRoutineGraphEnabled):
 * force with AGENT_LANGGRAPH_CHECKPOINT=true/false; otherwise ON in Vercel
 * preview only — production runs checkpoint-free until the owner canaries it.
 */
export function isGraphCheckpointEnabled(
  flag = process.env.AGENT_LANGGRAPH_CHECKPOINT,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  if (flag === 'true') return true
  if (flag === 'false') return false
  return vercelEnv === 'preview'
}

let pool: Pool | null = null
let saver: PostgresSaver | null = null
let initFailed = false
let gateLogged = false

function logGateOnce(enabled: boolean, reason: string): void {
  if (gateLogged) return
  gateLogged = true
  console.log(
    `[graph-checkpointer] gate: enabled=${enabled} reason=${reason} flag=${process.env.AGENT_LANGGRAPH_CHECKPOINT ?? 'unset'} vercelEnv=${process.env.VERCEL_ENV ?? 'unset'}`,
  )
}

/**
 * The shared checkpointer, or null when gated off / unconfigured / broken.
 * Never throws; never calls setup() (DDL belongs to the Prisma migration).
 */
export function getGraphCheckpointer(): PostgresSaver | null {
  if (!isGraphCheckpointEnabled()) {
    logGateOnce(false, 'gate_off')
    return null
  }
  if (initFailed) return null
  if (saver) return saver
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    initFailed = true
    logGateOnce(false, 'no_database_url')
    return null
  }
  try {
    pool = new Pool({ connectionString: url, max: 2 })
    // An idle-client error (pooler restart, network blip) must not crash the
    // lambda — swallow it; the next query gets a fresh client from the pool.
    pool.on('error', (err) => {
      console.warn('[graph-checkpointer] pool error (ignored):', err.message)
    })
    saver = new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA })
    logGateOnce(true, 'ready')
    return saver
  } catch (err) {
    initFailed = true
    console.warn('[graph-checkpointer] init failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Config fragment for a checkpointed graph invoke: thread = the conversation
 * (roadmap: thread_id ↔ conversationId, turnId in metadata), durability 'sync'
 * — on serverless the process may be frozen/killed the moment the response
 * flushes, so every super-step persists BEFORE the next one starts; 'async'
 * could lose the write that made the step resumable.
 */
export function checkpointConfigFor(opts: {
  conversationId?: string | null
  turnId?: string | null
  /** Namespace per graph so different graphs on one conversation never collide. */
  namespace: string
}): {
  configurable: { thread_id: string; checkpoint_ns: string }
  metadata: Record<string, unknown>
  durability: 'sync'
} {
  return {
    configurable: {
      thread_id: opts.conversationId?.trim() || `turn:${opts.turnId ?? 'anon'}`,
      checkpoint_ns: opts.namespace,
    },
    metadata: { turnId: opts.turnId ?? null },
    durability: 'sync',
  }
}

/**
 * TTL cleanup (roadmap risk item: checkpoint table growth). Deletes WHOLE
 * threads whose newest checkpoint is older than the TTL — mid-thread deletes
 * would break parent-chain resume, whole-thread deletes cannot. Rides the
 * open-task-nudge internal cron; best-effort (returns null on any failure).
 */
export async function cleanupGraphCheckpoints(
  maxAgeDays = CHECKPOINT_TTL_DAYS,
): Promise<{ threads: number } | null> {
  // Cleanup uses the same gate + pool as the saver — when the feature is off
  // there is nothing growing, so there is nothing to clean.
  if (!getGraphCheckpointer() || !pool) return null
  try {
    const res = await pool.query(
      `WITH stale AS (
         SELECT thread_id FROM "${CHECKPOINT_SCHEMA}"."checkpoints"
         GROUP BY thread_id
         HAVING max(created_at) < now() - make_interval(days => $1)
       ),
       del_writes AS (
         DELETE FROM "${CHECKPOINT_SCHEMA}"."checkpoint_writes"
         WHERE thread_id IN (SELECT thread_id FROM stale)
       ),
       del_blobs AS (
         DELETE FROM "${CHECKPOINT_SCHEMA}"."checkpoint_blobs"
         WHERE thread_id IN (SELECT thread_id FROM stale)
       ),
       del_cp AS (
         DELETE FROM "${CHECKPOINT_SCHEMA}"."checkpoints"
         WHERE thread_id IN (SELECT thread_id FROM stale)
       )
       SELECT count(*)::int AS threads FROM stale`,
      [maxAgeDays],
    )
    const threads = Number(res.rows[0]?.threads ?? 0)
    if (threads > 0) console.log(`[graph-checkpointer] TTL cleanup: ${threads} stale thread(s) deleted (> ${maxAgeDays}d)`)
    return { threads }
  } catch (err) {
    console.warn('[graph-checkpointer] cleanup failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Test hook: reset module singletons (vitest only). */
export function __resetGraphCheckpointerForTests(): void {
  try { void pool?.end() } catch { /* best-effort */ }
  pool = null
  saver = null
  initFailed = false
  gateLogged = false
}
