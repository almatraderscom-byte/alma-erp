/**
 * Phase 1 (autonomy foundation) — the AUTONOMY LEDGER (audit log + one-tap undo).
 *
 * If the agent is going to act on its own, the owner must be able to see exactly
 * what it did and reverse anything he didn't want. This module is that ledger:
 *   • recordAutonomousAction — append a tamper-light entry every time the agent
 *     auto-fires (or auto-executes an accepted proposal), with an optional UNDO
 *     descriptor (the inverse tool + params).
 *   • undoAction — re-dispatch that inverse through the normal tool registry and
 *     mark the entry undone. The owner's safety net.
 *   • buildAutonomyDigest — the once-a-day "here's what I handled for you, undo any?"
 *     report, so autonomy is always transparent, never a black box.
 *
 * Storage (Phase 53): the SOURCE OF TRUTH is the durable effect engine
 * (agent_action_runs + append-only agent_effect_ledger). The capped KV ring in
 * agent_kv_settings (`autonomy_action_log`) is retained ONLY as a derived
 * recent-view cache for the fast digest/undo paths — it is never authoritative.
 * New effect flows must go through effects/action-run.executeEffect, where a
 * ledger failure BLOCKS the effect; this legacy recorder mirrors durable-first
 * for call sites that record after the fact.
 */
import { prisma } from '@/lib/prisma'

export const AUTONOMY_LOG_KEY = 'autonomy_action_log'
export const AUTONOMY_DIGEST_SENT_KEY_PREFIX = 'autonomy_digest_sent:'
/** Keep the most-recent N entries; older ones age out. */
export const MAX_LEDGER_ENTRIES = 100

export interface UndoDescriptor {
  /** Registry tool that reverses the action. */
  tool: string
  params: Record<string, unknown>
  /** Owner-facing Bangla label, e.g. "টুডুটা মুছে দাও". */
  label: string
}

export interface LedgerEntry {
  id: string
  at: string // ISO
  category: string
  /** Bangla: what was done. */
  summary: string
  /** How it was authorised: silently auto, or an accepted proposal. */
  mode: 'auto' | 'propose'
  undo?: UndoDescriptor
  undone?: boolean
  undoneAt?: string
}

function genId(): string {
  return `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function readLog(): Promise<LedgerEntry[]> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: AUTONOMY_LOG_KEY }, select: { value: true } })
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : []
  } catch {
    return []
  }
}

async function writeLog(entries: LedgerEntry[]): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: AUTONOMY_LOG_KEY },
    create: { key: AUTONOMY_LOG_KEY, value: JSON.stringify(entries) },
    update: { value: JSON.stringify(entries) },
  })
}

/**
 * Record one autonomous action. Returns the new entry id (or null if logging
 * failed — the caller should treat logging as best-effort and never block the
 * action on it).
 */
export async function recordAutonomousAction(entry: {
  category: string
  summary: string
  mode: 'auto' | 'propose'
  undo?: UndoDescriptor
}): Promise<string | null> {
  const id = genId()

  // Phase 53: durable ledger FIRST (agent_action_runs + append-only chain).
  // The KV ring below is only the derived recent-view cache.
  let durable = false
  try {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const db = prisma as any
    await db.$transaction(async (tx: any) => {
      const run = await tx.agentActionRun.create({
        data: {
          idempotencyKey: `autonomy:${id}`,
          effectHash: id,
          tool: entry.undo?.tool ?? 'legacy_autonomous_action',
          surface: 'scheduler',
          actor: 'agent',
          instructionOrigin: entry.mode === 'auto' ? 'owner_policy' : 'model_initiative',
          riskTier: 'R1',
          policyVersion: 'legacy',
          state: 'succeeded',
          input: { category: entry.category, summary: entry.summary, mode: entry.mode },
          proof: { kind: 'legacy_autonomy_record' },
        },
      })
      await tx.agentEffectLedger.create({
        data: { runId: run.id, seq: 1, kind: 'transition', fromState: null, toState: 'succeeded', payload: { legacy: true } },
      })
      await tx.agentEffectLedger.create({
        data: { runId: run.id, seq: 2, kind: 'proof', payload: { kind: 'legacy_autonomy_record', undo: entry.undo ?? null } },
      })
    })
    /* eslint-enable @typescript-eslint/no-explicit-any */
    durable = true
  } catch (err) {
    console.warn('[autonomy-ledger] durable ledger write failed (KV cache only):', err instanceof Error ? err.message : err)
  }

  try {
    const log = await readLog()
    log.push({ id, at: new Date().toISOString(), category: entry.category, summary: entry.summary, mode: entry.mode, undo: entry.undo })
    await writeLog(log.slice(-MAX_LEDGER_ENTRIES))
    return id
  } catch {
    // KV cache failed — the durable row (if written) still holds the truth.
    return durable ? id : null
  }
}

/** Most-recent autonomous actions, newest first. */
export async function listRecentActions(limit = 20): Promise<LedgerEntry[]> {
  const log = await readLog()
  return [...log].reverse().slice(0, Math.max(1, limit))
}

export async function getAction(id: string): Promise<LedgerEntry | null> {
  const log = await readLog()
  return log.find((e) => e.id === id) ?? null
}

export interface UndoResult {
  ok: boolean
  detail: string
  entry?: LedgerEntry
}

/**
 * Reverse a recorded autonomous action by re-dispatching its undo descriptor
 * through the normal tool registry, then mark it undone. `id` may be a specific
 * entry id or the literal 'last' (most-recent undoable, not-yet-undone entry).
 */
export async function undoAction(id: string): Promise<UndoResult> {
  const log = await readLog()
  const entry =
    id === 'last'
      ? [...log].reverse().find((e) => e.undo && !e.undone)
      : log.find((e) => e.id === id)

  if (!entry) return { ok: false, detail: 'not_found' }
  if (entry.undone) return { ok: false, detail: 'already_undone', entry }
  if (!entry.undo) return { ok: false, detail: 'no_undo_available', entry }

  // Re-dispatch the inverse via the registry. Dynamic import avoids a circular
  // dependency (registry → tools → ... → this module).
  try {
    const { executeTool } = await import('@/agent/tools/registry')
    const res = await executeTool(entry.undo.tool, entry.undo.params)
    if (!res.success) {
      return { ok: false, detail: `undo_tool_failed: ${res.error ?? 'unknown'}`, entry }
    }
  } catch (err) {
    return { ok: false, detail: `undo_dispatch_error: ${err instanceof Error ? err.message : String(err)}`, entry }
  }

  entry.undone = true
  entry.undoneAt = new Date().toISOString()
  await writeLog(log).catch(() => {})
  return { ok: true, detail: 'undone', entry }
}

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}

/**
 * Build the owner-facing daily transparency digest: everything the agent did on
 * its own SINCE the given instant (default: last 24h), with undo hints. Returns
 * null when there is nothing autonomous to report.
 */
export async function buildAutonomyDigest(sinceIso?: string): Promise<{ count: number; message: string } | null> {
  const log = await readLog()
  const since = sinceIso ? new Date(sinceIso).getTime() : Date.now() - 24 * 60 * 60 * 1000
  const recent = log.filter((e) => new Date(e.at).getTime() >= since && !e.undone)
  if (recent.length === 0) return null

  const fmtTime = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))

  const lines: string[] = []
  lines.push(`🤖 *আমি নিজে যা সামলেছি* — ${bn(recent.length)}টি কাজ:`)
  lines.push('')
  recent
    .slice(-20)
    .forEach((e, i) => {
      lines.push(`${bn(i + 1)}. (${fmtTime(e.at)}) ${e.summary}`)
      if (e.undo) lines.push(`   ↩️ ফেরাতে চাইলে: "${e.undo.label}"`)
    })
  lines.push('')
  lines.push('কোনোটা ভুল হলে বলুন — সাথে সাথে ফিরিয়ে দেব, Boss।')
  return { count: recent.length, message: lines.join('\n') }
}

/** YYYY-MM-DD (Dhaka) for the per-day digest dedup guard. */
function ymdDhaka(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)
}

export interface AutonomyDigestSendResult {
  sent: boolean
  detail: string
  count?: number
}

/**
 * AUTO daily transparency report — called from the day-start sequence. Sends ONE
 * batched "here's what I handled" card (tier-1, category 'report'), idempotent per
 * Dhaka-day via a KV guard. Skips silently when there's nothing autonomous to show
 * (e.g. autonomy still disabled). Best-effort — never throws.
 */
export async function runAutonomyDigestSend(opts: { now?: Date } = {}): Promise<AutonomyDigestSendResult> {
  try {
    const now = opts.now ?? new Date()
    const digest = await buildAutonomyDigest()
    if (!digest) return { sent: false, detail: 'nothing_to_report' }

    const guardKey = `${AUTONOMY_DIGEST_SENT_KEY_PREFIX}${ymdDhaka(now)}`
    const existing = await prisma.agentKvSetting.findUnique({ where: { key: guardKey }, select: { value: true } })
    if (existing?.value) return { sent: false, detail: 'already_sent', count: digest.count }

    const { notifyOwner } = await import('@/agent/lib/notify-owner')
    await notifyOwner({ tier: 1, title: '🤖 স্বয়ংক্রিয় কাজের হিসাব', message: digest.message, category: 'report' }).catch(() => {})

    await prisma.agentKvSetting.upsert({
      where: { key: guardKey },
      create: { key: guardKey, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    return { sent: true, detail: 'sent', count: digest.count }
  } catch (err) {
    return { sent: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
