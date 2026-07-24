/**
 * PA-2 — Proactive owner calls (executive-assistant escalation ladder).
 *
 * When something urgent needs the owner and he is not responding in the app —
 * a stuck approval, a stuck staff task, or a tier-3 business alert — the agent
 * CALLS him instead of only pushing: WhatsApp live call (Gemini Live, owner
 * persona) first; if unanswered after the stage wait, a direct PSTN call; if
 * still unreached, a tier-2 summary push. Sits ABOVE the notify-owner ladder.
 *
 * Safety model:
 *  - Autonomy is OFF by default (`proactive_calls_enabled` KV). While OFF, each
 *    escalation raises a "কল দেব?" approval card instead of dialing; approving
 *    the card runs the ladder once. The owner flips the KV to go full-auto.
 *  - Dhaka-day cap on ladders that actually dialed (`proactive_call_daily_cap`).
 *  - Quiet hours defer non-critical ladders (business alerts pierce).
 *  - One ACTIVE escalation per refId; placeOutboundCall's own kill switch and
 *    daily call cap still apply underneath.
 *
 * Everything runs on Vercel via /api/cron/call-escalations (same pattern as
 * /api/cron/scheduled-calls) — deliberately NOT on the VPS worker: worker
 * deploys are manual, and the 2026-07-14 Upstash incident showed cloud-queue
 * fragility. The DB table is the durable queue.
 */
import { prisma } from '@/lib/prisma'
import { placeOutboundCall } from '@/agent/lib/voice-call'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { sendOwnerApprovalCard } from '@/agent/lib/telegram-owner-notify'
import { getQuietHoursConfig, isQuietHoursDhaka } from '@/agent/lib/quiet-hours'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const ACTIVE_STATUSES = ['queued', 'awaiting_approval', 'wa_calling', 'pstn_calling'] as const

export interface ProactiveCallConfig {
  /** Autonomy: true → dial without asking. false (default) → approval card first. */
  enabled: boolean
  /** Minutes to wait on each call stage before moving down the ladder. */
  stageWaitMin: number
  /** Max ladders that may DIAL per Dhaka day. */
  dailyCap: number
  /** A pending approval older than this (minutes) triggers the ladder. */
  approvalStuckMin: number
  /** Faster threshold for urgent_notify approvals (minutes). */
  urgentStuckMin: number
}

const KV_KEYS = {
  enabled: 'proactive_calls_enabled',
  stageWaitMin: 'proactive_call_stage_wait_min',
  dailyCap: 'proactive_call_daily_cap',
  approvalStuckMin: 'proactive_call_approval_stuck_min',
  urgentStuckMin: 'proactive_call_urgent_stuck_min',
} as const

/** Approval types that must never trigger the approval_stuck scan. */
const APPROVAL_SCAN_EXCLUDED_TYPES = [
  // Would recurse: the ladder's own permission card.
  'proactive_call',
  // The VPS escalation-poller already places tier-3 calls for these two.
  'staff_auto_message',
  'duty_approval_block',
]

async function kvGet(key: string): Promise<string | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key } })
    return row?.value ?? null
  } catch {
    return null
  }
}

function kvNumber(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export async function getProactiveCallConfig(): Promise<ProactiveCallConfig> {
  const [enabled, stageWait, cap, stuck, urgent] = await Promise.all([
    kvGet(KV_KEYS.enabled),
    kvGet(KV_KEYS.stageWaitMin),
    kvGet(KV_KEYS.dailyCap),
    kvGet(KV_KEYS.approvalStuckMin),
    kvGet(KV_KEYS.urgentStuckMin),
  ])
  return {
    enabled: enabled === 'true',
    stageWaitMin: kvNumber(stageWait, 3, 1, 30),
    dailyCap: kvNumber(cap, 4, 1, 20),
    approvalStuckMin: kvNumber(stuck, 15, 3, 240),
    urgentStuckMin: kvNumber(urgent, 5, 1, 60),
  }
}

/** Owner's primary dialable number (first entry of OWNER_PHONE_NUMBERS). */
export function ownerPrimaryNumber(): string | null {
  const first = (process.env.OWNER_PHONE_NUMBERS ?? '').split(',')[0]?.trim()
  return first || null
}

export function dhakaDayStart(now = new Date()): Date {
  const dhaka = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
  const diff = now.getTime() - dhaka.getTime()
  dhaka.setHours(0, 0, 0, 0)
  return new Date(dhaka.getTime() + diff)
}

/** Terminal outcome of an agent_voice_calls row, from the ladder's viewpoint. */
export function callOutcome(call: { status?: string | null } | null): 'answered' | 'unreached' | 'pending' {
  const s = call?.status ?? ''
  if (s === 'completed' || s === 'report_missing') return 'answered'
  if (s === 'no_answer' || s === 'busy' || s === 'failed') return 'unreached'
  return 'pending'
}

export interface QueueEscalationInput {
  /** boss_callback (PA-5R): the boss ASKED to be called back when the work is
   * done — verbal/explicit consent already given, so the ladder dials without
   * the "কল দেব?" permission card, under its own daily cap. */
  trigger: 'approval_stuck' | 'staff_task_stuck' | 'business_alert' | 'manual' | 'boss_callback'
  refId: string
  title: string
  purpose: string
}

/**
 * Queue a call escalation. Dedupes on ANY prior row with the same refId — active
 * OR resolved (live lesson 2026-07-23: a cancelled row must not resurrect next
 * tick while its cause persists; one refId = one ladder, ever. refIds that may
 * legitimately re-fire are day-scoped by their producer, e.g. staff_task:<id>:<date>).
 * Returns the row id, or null when deduped / feature entirely unconfigured.
 */
export async function queueCallEscalation(input: QueueEscalationInput): Promise<string | null> {
  if (!ownerPrimaryNumber()) return null
  const existing = await db.agentCallEscalation.findFirst({
    where: { refId: input.refId },
    select: { id: true },
  })
  if (existing) return null
  const row = await db.agentCallEscalation.create({
    data: {
      trigger: input.trigger,
      refId: input.refId,
      title: input.title.slice(0, 200),
      purpose: input.purpose.slice(0, 2000),
      status: 'queued',
      nextCheckAt: new Date(),
    },
  })
  return row.id
}

/** Trigger scan 1 — approvals sitting unanswered too long. */
async function scanStuckApprovals(cfg: ProactiveCallConfig): Promise<number> {
  const now = Date.now()
  // One active approval_stuck ladder at a time — the call itself says
  // "N টা approval pending", so parallel ladders would only double-dial.
  const active = await db.agentCallEscalation.findFirst({
    where: { trigger: 'approval_stuck', status: { in: [...ACTIVE_STATUSES] } },
    select: { id: true },
  })
  if (active) return 0

  const oldest = new Date(now - cfg.approvalStuckMin * 60_000)
  const urgentOldest = new Date(now - cfg.urgentStuckMin * 60_000)
  const stuck = await db.agentPendingAction.findMany({
    where: {
      status: 'pending',
      type: { notIn: APPROVAL_SCAN_EXCLUDED_TYPES },
      OR: [
        { createdAt: { lte: oldest } },
        { type: 'urgent_notify', createdAt: { lte: urgentOldest } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, summary: true, type: true },
    take: 5,
  })
  if (!stuck.length) return 0

  const first = stuck[0]
  const summary = String(first.summary ?? first.type).slice(0, 140)
  const id = await queueCallEscalation({
    trigger: 'approval_stuck',
    refId: `approval:${first.id}`,
    title: `Approval আটকে আছে (${stuck.length}টা)`,
    purpose:
      `Boss-এর অনুমোদনের অপেক্ষায় ${stuck.length}টা কাজ আটকে আছে। ` +
      `সবচেয়ে পুরনোটা: ${summary}। Boss-কে জানাও যে app বা Telegram-এ approve/reject করা দরকার।`,
  })
  return id ? 1 : 0
}

/** Trigger scan 2 — staff tasks the supervisor escalated / flagged for the owner. */
async function scanStuckStaffTasks(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 60_000)
  // Recency floor (live bug 2026-07-23): without it the scan dredged up month-old
  // done tasks whose needs-owner flag was never cleared and queued calls for them.
  // Only a flag raised within the last 24h — and ≥30 min ago — is call-worthy.
  const recent = new Date(Date.now() - 24 * 3600_000)
  const tasks = await db.agentStaffTask.findMany({
    where: {
      // Statuses that are actually in-flight ('done'/'carried'/'cancelled' etc. are not).
      status: { in: ['proposed', 'sent', 'awaiting_proof'] },
      OR: [
        { escalatedAt: { lte: cutoff, gte: recent } },
        { supervisorNeedsOwner: true, supervisorLastTickAt: { lte: cutoff, gte: recent } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, staff: { select: { name: true } } },
    take: 3,
  })
  let queued = 0
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  for (const task of tasks) {
    const staffName = task.staff?.name ?? 'Staff'
    const id = await queueCallEscalation({
      trigger: 'staff_task_stuck',
      // Once per task per Dhaka day.
      refId: `staff_task:${task.id}:${day}`,
      title: `Staff task আটকে: ${String(task.title).slice(0, 80)}`,
      purpose:
        `${staffName}-এর কাজ "${task.title}" আটকে আছে — supervisor Boss-এর সিদ্ধান্ত চায়। ` +
        `Boss-কে বিষয়টা জানাও আর কী করতে হবে জেনে নাও।`,
    })
    if (id) queued++
  }
  return queued
}

/** Both trigger scans (business_alert rows are queued at the source instead). */
export async function scanEscalationTriggers(): Promise<{ queued: number }> {
  const cfg = await getProactiveCallConfig()
  let queued = 0
  try { queued += await scanStuckApprovals(cfg) } catch (err) {
    console.warn('[proactive-call] approval scan failed:', err instanceof Error ? err.message : String(err))
  }
  try { queued += await scanStuckStaffTasks() } catch (err) {
    console.warn('[proactive-call] staff-task scan failed:', err instanceof Error ? err.message : String(err))
  }
  return { queued }
}

async function laddersDialedToday(): Promise<number> {
  // boss_callback rides its own cap — keep it out of the proactive budget.
  return db.agentCallEscalation.count({
    where: { firstCallAt: { gte: dhakaDayStart() }, trigger: { not: 'boss_callback' } },
  })
}

async function resolve(id: string, status: string, extra: Record<string, unknown> = {}) {
  await db.agentCallEscalation.update({
    where: { id },
    data: { status, resolvedAt: new Date(), nextCheckAt: null, ...extra },
  })
}

/** Place one ladder call (wa → pstn fallback handled by the caller's stages). */
async function dialOwner(row: { id: string; purpose: string; title: string }, channel: 'whatsapp' | 'phone') {
  const toNumber = ownerPrimaryNumber()
  if (!toNumber) return { ok: false as const, error: 'OWNER_PHONE_NUMBERS empty' }
  return placeOutboundCall({
    toNumber,
    recipientName: 'Boss',
    purpose: `জরুরি proactive কল — ${row.title}। ${row.purpose}`,
    firstMessage: '',
    callType: 'owner',
    channel,
  })
}

/**
 * Advance an approved/queued escalation into its first call stage.
 * Used by the cron AND inline by the 'proactive_call' approve handler.
 */
export async function startEscalationLadder(id: string, cfg?: ProactiveCallConfig): Promise<{ ok: boolean; stage?: string; error?: string }> {
  const config = cfg ?? await getProactiveCallConfig()
  const row = await db.agentCallEscalation.findUnique({ where: { id } })
  if (!row) return { ok: false, error: 'not_found' }
  // Claim so a racing cron tick / double tap can't double-dial.
  const claimed = await db.agentCallEscalation.updateMany({
    where: { id, status: { in: ['queued', 'awaiting_approval'] } },
    data: { status: 'wa_calling', firstCallAt: new Date() },
  })
  if (claimed.count !== 1) return { ok: false, error: 'already_started' }

  const nextCheckAt = new Date(Date.now() + config.stageWaitMin * 60_000)
  const wa = await dialOwner(row, 'whatsapp').catch((err) => ({ ok: false as const, error: String(err?.message ?? err) }))
  if (wa.ok) {
    await db.agentCallEscalation.update({
      where: { id },
      data: { waCallId: (wa as { callRecordId?: string }).callRecordId ?? null, nextCheckAt },
    })
    return { ok: true, stage: 'wa_calling' }
  }

  // WhatsApp leg unavailable (kill switch, permission, config) → straight to PSTN.
  const pstn = await dialOwner(row, 'phone').catch((err) => ({ ok: false as const, error: String(err?.message ?? err) }))
  if (pstn.ok) {
    await db.agentCallEscalation.update({
      where: { id },
      data: {
        status: 'pstn_calling',
        pstnCallId: (pstn as { callRecordId?: string }).callRecordId ?? null,
        nextCheckAt,
        note: `wa skipped: ${wa.error ?? 'unknown'}`.slice(0, 300),
      },
    })
    return { ok: true, stage: 'pstn_calling' }
  }

  await resolve(id, 'failed', { note: `wa: ${wa.error ?? '?'} | pstn: ${pstn.error ?? '?'}`.slice(0, 500) })
  await pushUnreachedSummary(row, 'কল দেওয়াই যায়নি')
  return { ok: false, error: pstn.error ?? wa.error ?? 'dial failed' }
}

async function pushUnreachedSummary(row: { title: string; purpose: string }, reason: string) {
  try {
    await notifyOwner({
      tier: 2,
      title: `📞 ${row.title}`,
      message: `Boss, আপনাকে কলে পাইনি (${reason})। বিষয়টা ছিল: ${row.purpose.slice(0, 400)}`,
      category: 'urgent',
      telegramMode: 'always',
      actionUrl: '/agent',
    })
  } catch (err) {
    console.warn('[proactive-call] unreached push failed:', err instanceof Error ? err.message : String(err))
  }
}

/** Ladder state machine — run every minute by /api/cron/call-escalations. */
export async function processCallEscalations(limit = 10): Promise<Array<{ id: string; outcome: string }>> {
  const cfg = await getProactiveCallConfig()
  const now = new Date()
  const due = await db.agentCallEscalation.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] }, nextCheckAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  const results: Array<{ id: string; outcome: string }> = []

  for (const row of due) {
    try {
      results.push({ id: row.id, outcome: await stepEscalation(row, cfg) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[proactive-call] step failed for ${row.id}:`, msg)
      results.push({ id: row.id, outcome: `error: ${msg.slice(0, 120)}` })
    }
  }
  return results
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stepEscalation(row: any, cfg: ProactiveCallConfig): Promise<string> {
  if (row.status === 'queued') {
    // Quiet hours: defer non-critical ladders; business alerts pierce.
    if (row.trigger !== 'business_alert') {
      try {
        const quiet = await getQuietHoursConfig()
        if (isQuietHoursDhaka(new Date(), quiet)) {
          await db.agentCallEscalation.update({
            where: { id: row.id },
            data: { nextCheckAt: new Date(Date.now() + 30 * 60_000) },
          })
          return 'deferred_quiet_hours'
        }
      } catch { /* fail-open */ }
    }

    // PA-5R boss-callback: the boss explicitly asked "শেষ হলে কল করে জানাবে" —
    // that IS the consent, so no permission card. Own (higher) daily cap; on
    // cap overflow the report still reaches him as a push.
    if (row.trigger === 'boss_callback') {
      const cbCap = kvNumber(await kvGet('proactive_callback_daily_cap'), 10, 1, 50)
      const cbToday = await db.agentCallEscalation.count({
        where: { trigger: 'boss_callback', firstCallAt: { gte: dhakaDayStart() } },
      })
      if (cbToday >= cbCap) {
        await resolve(row.id, 'cancelled', { note: `callback daily cap ${cbCap} reached` })
        await pushUnreachedSummary(row, 'আজকের callback-কল লিমিট শেষ — রিপোর্টটা এখানে')
        return 'cancelled_daily_cap'
      }
      const started = await startEscalationLadder(row.id, cfg)
      return started.ok ? `dialed_${started.stage}` : `dial_failed: ${started.error}`
    }

    if ((await laddersDialedToday()) >= cfg.dailyCap) {
      await resolve(row.id, 'cancelled', { note: `daily cap ${cfg.dailyCap} reached` })
      await pushUnreachedSummary(row, 'আজকের proactive কল লিমিট শেষ')
      return 'cancelled_daily_cap'
    }

    if (!cfg.enabled) {
      // Autonomy OFF → permission card instead of dialing.
      const action = await db.agentPendingAction.create({
        data: {
          type: 'proactive_call',
          payload: { escalationId: row.id, trigger: row.trigger, title: row.title },
          summary: `📞 কল দেব? — ${row.title}`,
          costEstimate: 0.05,
          status: 'pending',
        },
      })
      await db.agentCallEscalation.update({
        where: { id: row.id },
        data: {
          status: 'awaiting_approval',
          approvalActionId: action.id,
          // Re-check to catch reject / 24h expiry.
          nextCheckAt: new Date(Date.now() + 5 * 60_000),
        },
      })
      await sendOwnerApprovalCard({
        summary: `📞 Boss, জরুরি বিষয়: ${row.title}\n\n${row.purpose.slice(0, 300)}\n\nআপনাকে কল দেব?`,
        pendingActionId: action.id,
        approveLabel: '✅ কল দাও',
        rejectLabel: '❌ দরকার নেই',
      }).catch(() => {})
      return 'awaiting_approval'
    }

    const started = await startEscalationLadder(row.id, cfg)
    return started.ok ? `dialed_${started.stage}` : `dial_failed: ${started.error}`
  }

  if (row.status === 'awaiting_approval') {
    const action = row.approvalActionId
      ? await db.agentPendingAction.findUnique({ where: { id: row.approvalActionId }, select: { status: true } })
      : null
    // Approve handler normally starts the ladder inline — if it crashed after
    // approving, recover here.
    if (action && (action.status === 'approved' || action.status === 'executed')) {
      const started = await startEscalationLadder(row.id, cfg)
      return started.ok ? `dialed_${started.stage}` : `dial_failed: ${started.error}`
    }
    // Anything but a live pending card (rejected / cancelled / expired / missing) ends the ladder.
    if (!action || action.status !== 'pending') {
      await resolve(row.id, 'cancelled', { note: `permission card ${action?.status ?? 'missing'}` })
      return 'cancelled_rejected'
    }
    // Card still pending — only expire stale ones.
    if (Date.now() - new Date(row.createdAt).getTime() > 24 * 3600_000) {
      await resolve(row.id, 'cancelled', { note: 'permission card expired (24h)' })
      return 'cancelled_expired'
    }
    await db.agentCallEscalation.update({
      where: { id: row.id },
      data: { nextCheckAt: new Date(Date.now() + 5 * 60_000) },
    })
    return 'still_awaiting_approval'
  }

  if (row.status === 'wa_calling' || row.status === 'pstn_calling') {
    const isWa = row.status === 'wa_calling'
    const callId = isWa ? row.waCallId : row.pstnCallId
    const call = callId
      ? await db.agentVoiceCall.findUnique({ where: { id: callId }, select: { status: true } })
      : null
    const outcome = callOutcome(call)

    if (outcome === 'answered') {
      await resolve(row.id, 'answered')
      return 'answered'
    }
    const timedOut = row.nextCheckAt && new Date(row.nextCheckAt).getTime() <= Date.now()
    if (outcome === 'pending' && !timedOut) return 'waiting'

    if (isWa) {
      // WhatsApp unanswered/timed out → PSTN leg.
      const pstn = await dialOwner(row, 'phone').catch((err) => ({ ok: false as const, error: String(err?.message ?? err) }))
      if (pstn.ok) {
        await db.agentCallEscalation.update({
          where: { id: row.id },
          data: {
            status: 'pstn_calling',
            pstnCallId: (pstn as { callRecordId?: string }).callRecordId ?? null,
            nextCheckAt: new Date(Date.now() + cfg.stageWaitMin * 60_000),
          },
        })
        return 'escalated_to_pstn'
      }
      await resolve(row.id, 'unreached', { note: `pstn dial failed: ${pstn.error ?? '?'}`.slice(0, 300) })
      await pushUnreachedSummary(row, 'WhatsApp কল ধরা হয়নি, সরাসরি কলও যায়নি')
      return 'unreached_pstn_failed'
    }

    await resolve(row.id, 'unreached')
    await pushUnreachedSummary(row, 'দুই দফা কলেও ধরা হয়নি')
    return 'unreached'
  }

  return `noop_${row.status}`
}
