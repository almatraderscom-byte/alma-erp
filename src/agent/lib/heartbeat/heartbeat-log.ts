/**
 * Phase 5 (autonomous heartbeat) — the HEARTBEAT LOG (visible "agent is alive" feed).
 *
 * The owner asked for an "idle heartbeat": the head (Claude) periodically waking on
 * its own to look at the business and proactively act/alert — AND being able to SEE
 * it, the same way the owner can watch a scheduled wake-up fire. This module is the
 * visible record: EVERY heartbeat tick appends one entry here (even the quiet "all
 * good, didn't need to wake the head" ticks), so the owner can scroll a timeline and
 * know the heartbeat is alive and what it considered each time.
 *
 * Two surfaces feed off this log:
 *   • the /agent UI heartbeat panel (a timeline of recent ticks), and
 *   • the per-day heartbeat conversation (when the head DOES wake, its reasoning is a
 *     normal assistant message the owner can open and read).
 *
 * Storage mirrors the autonomy ledger: a CAPPED ring buffer in agent_kv_settings
 * (`heartbeat_log`) — no migration. Best-effort and fail-safe: a logging glitch must
 * never break (or trigger) the tick it records.
 */
import { prisma } from '@/lib/prisma'

export const HEARTBEAT_LOG_KEY = 'heartbeat_log'
/** Keep the most-recent N ticks; older ones age out. */
export const MAX_HEARTBEAT_ENTRIES = 60

/** Cheap, DB-only business "pulse" — the change-detector that gates head wake-ups. */
export interface HeartbeatPulse {
  /** Agent actions waiting for the owner's Approve/Reject. */
  pendingApprovals: number
  /** Staff tasks the supervisor escalated to the owner. */
  ownerEscalations: number
  /** Open owner to-dos (pending / in-progress). */
  openTodos: number
  // ── Proactive anomaly signals (cheap DB-only; optional for back-compat with
  //    older stored ticks that predate them). ──────────────────────────────────
  /** Unresolved customer-service alerts (messenger) — customers waiting. */
  csAlerts?: number
  /** Pending staff money requests (wallet / advance) awaiting the owner's review. */
  moneyRequests?: number
  /** Pending agent approvals older than 2 days — at risk of silently expiring. */
  agingApprovals?: number
}

export type HeartbeatKind =
  /** Quiet tick: pulse unchanged or nothing actionable — head was NOT woken. */
  | 'idle'
  /** Head woke, looked around, and acted/reported. */
  | 'active'
  /** Head woke and parked something for the owner's approval. */
  | 'blocked'
  /** Owner stopped an in-flight autonomous wake from Background Tasks. */
  | 'stopped'
  /** Tick errored (recorded so the owner sees the gap, never silent). */
  | 'error'

export interface HeartbeatEntry {
  id: string
  at: string // ISO
  kind: HeartbeatKind
  pulse: HeartbeatPulse
  /** Did this tick wake the head (cost-bearing) or stay a cheap pulse check? */
  headWoke: boolean
  /** Bangla one-liner: what the heartbeat concluded / did. */
  summary: string
  /** Head-turn cost in USD when the head woke (0 otherwise). */
  costUsd?: number
  /** Heartbeat conversation this tick wrote into (deep-link target for the UI). */
  conversationId?: string
}

function genId(): string {
  return `hb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Stable string identity of a pulse — equal strings ⇒ "nothing changed". */
export function pulseFingerprint(p: HeartbeatPulse): string {
  return `${p.pendingApprovals}|${p.ownerEscalations}|${p.openTodos}|${p.csAlerts ?? 0}|${p.moneyRequests ?? 0}|${p.agingApprovals ?? 0}`
}

async function readLog(): Promise<HeartbeatEntry[]> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: HEARTBEAT_LOG_KEY }, select: { value: true } })
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? (parsed as HeartbeatEntry[]) : []
  } catch {
    return []
  }
}

async function writeLog(entries: HeartbeatEntry[]): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: HEARTBEAT_LOG_KEY },
    create: { key: HEARTBEAT_LOG_KEY, value: JSON.stringify(entries) },
    update: { value: JSON.stringify(entries) },
  })
}

/**
 * Append one heartbeat tick. Returns the new entry (or null if logging failed —
 * the caller treats logging as best-effort and never blocks the tick on it).
 */
export async function recordHeartbeat(entry: {
  kind: HeartbeatKind
  pulse: HeartbeatPulse
  headWoke: boolean
  summary: string
  costUsd?: number
  conversationId?: string
}): Promise<HeartbeatEntry | null> {
  try {
    const log = await readLog()
    const row: HeartbeatEntry = {
      id: genId(),
      at: new Date().toISOString(),
      kind: entry.kind,
      pulse: entry.pulse,
      headWoke: entry.headWoke,
      summary: entry.summary,
      ...(entry.costUsd != null ? { costUsd: entry.costUsd } : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    }
    log.push(row)
    await writeLog(log.slice(-MAX_HEARTBEAT_ENTRIES))
    return row
  } catch {
    return null
  }
}

/** Most-recent heartbeat ticks, newest first. */
export async function listHeartbeats(limit = 30): Promise<HeartbeatEntry[]> {
  const log = await readLog()
  return [...log].reverse().slice(0, Math.max(1, limit))
}

/** The single most-recent tick (for change-detection), or null if none yet. */
export async function lastHeartbeat(): Promise<HeartbeatEntry | null> {
  const log = await readLog()
  return log.length ? log[log.length - 1] : null
}

/** YYYY-MM-DD (Dhaka) for the per-day head-wake cap. */
function ymdDhaka(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)
}

/** How many times the head has woken today (Dhaka) — enforces the daily cost cap. */
export async function headWakesToday(now: Date = new Date()): Promise<number> {
  const today = ymdDhaka(now)
  const log = await readLog()
  return log.filter((e) => e.headWoke && ymdDhaka(new Date(e.at)) === today).length
}
