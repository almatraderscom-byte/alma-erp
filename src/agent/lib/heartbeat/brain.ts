/**
 * Phase 5 (autonomous heartbeat) — the BRAIN tick.
 *
 * This is the "idle heartbeat" the owner asked for: on a Vercel cron the agent
 * wakes ON ITS OWN, glances at the business, and — only when something is worth it
 * — wakes the HEAD to proactively act or alert the owner, under the same autonomy
 * policy that governs every other self-action (so it never moves money or does
 * anything irreversible on its own; at most it proposes / files an approval).
 *
 * By owner decision the self-wake head runs on the CHEAP model (DeepSeek), not
 * Sonnet — a routine autonomous glance shouldn't pay Claude rates every tick (see
 * heartbeatHeadModelId). A delegated finance/data-analysis sub-task is still
 * hard-guarded to Claude, so money reasoning never drops to a cheap model.
 *
 * Cost discipline (the owner is cost-sensitive) — three gates, cheapest first:
 *   1. enabled + office-hours: a disabled or off-hours tick is a near-free no-op.
 *   2. PULSE change-detection: a cheap DB-only snapshot (counts of pending
 *      approvals / owner escalations / open to-dos). If the pulse is unchanged
 *      since the last tick, OR there is nothing actionable, we DON'T wake the head
 *      — we just record a quiet "idle" heartbeat so the owner still sees it's alive.
 *   3. daily cap: past dailyHeadWakeCap head wakes today, we stop waking the head.
 * The head only runs (the one cost-bearing step) when the pulse actually changed to
 * something actionable AND we're under the cap.
 *
 * Visibility: every tick — idle or active — appends to the heartbeat log (the UI
 * timeline). When the head DOES wake, the turn lands INLINE at the bottom of the
 * owner's currently-open chat (his session pointer / most-recent main chat), so it
 * surfaces in his running session like Claude Code's ScheduleWakeup — the app's
 * message poll floats it in automatically. If he's mid-turn there (or no main chat
 * exists) it falls back to a per-day heartbeat thread, so a tick is never lost.
 *
 * Everything is best-effort and fail-safe: a model/DB/network error records an
 * 'error' heartbeat and returns — it never throws into the cron.
 */
import { prisma } from '@/lib/prisma'
import { isAgentEnabled } from '@/agent/config'
import { captureAgentError } from '@/agent/lib/sentry'
import { isWithinOfficeHours } from '@/agent/lib/office-supervisor'
import { runOwnerTurn } from '@/agent/lib/models/run-owner-turn'
import { getModel, isKnownModelId, DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'
import type { AgentEvent } from '@/agent/lib/core'
import { getOwnerSessionPointer } from '@/agent/lib/owner-session'
import { getLatestTurn } from '@/agent/lib/turn-status'
import { HEARTBEAT_WAKE_SENTINEL } from './wake-marker'
import {
  recordHeartbeat,
  lastHeartbeat,
  headWakesToday,
  pulseFingerprint,
  type HeartbeatPulse,
  type HeartbeatEntry,
} from './heartbeat-log'
import { getHeartbeatSettings, setHeartbeatSettings } from './heartbeat-settings'

const BUSINESS_ID = 'ALMA_LIFESTYLE'
const HEARTBEAT_CONV_KEY_PREFIX = 'heartbeat_conv:'
/** Hard wall-clock cap on a single head wake, so a stuck turn can't run forever. */
const MAX_WAKE_MS = 90_000

export interface HeartbeatTickResult {
  ran: boolean
  reason: string
  headWoke: boolean
  kind: HeartbeatEntry['kind'] | null
  pulse: HeartbeatPulse | null
  costUsd: number
  summary: string
}

// ── Pulse: the cheap DB-only change-detector ─────────────────────────────────

/**
 * A cheap snapshot of "is anything going on?" — three count queries, no LLM, no
 * external API. Drives change-detection so the head only wakes when the picture
 * actually shifts. Fail-safe: any error degrades to all-zero (treated as quiet).
 */
export async function gatherPulse(businessId: string = BUSINESS_ID): Promise<HeartbeatPulse> {
  try {
    // All counts are cheap DB-only queries (no LLM, no GAS/Meta) so a tick stays
    // near-free. The aging-approvals cutoff mirrors the 3-day approval expiry —
    // flag at 2 days so the owner gets a nudge BEFORE anything silently expires.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
    const [pendingApprovals, ownerEscalations, openTodos, csAlerts, moneyRequests, agingApprovals] = await Promise.all([
      prisma.agentPendingAction.count({ where: { status: 'pending' } }),
      prisma.agentStaffTask.count({ where: { businessId, supervisorNeedsOwner: true } }),
      prisma.agentTodo.count({ where: { businessId, status: { in: ['pending', 'in_progress'] } } }),
      prisma.agentMessengerAlert.count({ where: { resolved: false } }).catch(() => 0),
      prisma.walletRequest.count({ where: { status: 'PENDING', isArchived: false } }).catch(() => 0),
      prisma.agentPendingAction.count({ where: { status: 'pending', createdAt: { lt: twoDaysAgo } } }).catch(() => 0),
    ])
    return { pendingApprovals, ownerEscalations, openTodos, csAlerts, moneyRequests, agingApprovals }
  } catch {
    return { pendingApprovals: 0, ownerEscalations: 0, openTodos: 0, csAlerts: 0, moneyRequests: 0, agingApprovals: 0 }
  }
}

/** True when the pulse carries something the head could actually act on. */
export function pulseIsActionable(p: HeartbeatPulse): boolean {
  return (
    p.pendingApprovals > 0 ||
    p.ownerEscalations > 0 ||
    p.openTodos > 0 ||
    (p.csAlerts ?? 0) > 0 ||
    (p.moneyRequests ?? 0) > 0 ||
    (p.agingApprovals ?? 0) > 0
  )
}

/** Bangla one-liner describing a pulse, for the idle/quiet heartbeat entries. */
function describePulse(p: HeartbeatPulse): string {
  if (!pulseIsActionable(p)) return 'দেখলাম — এই মুহূর্তে জরুরি কিছু নেই, সব ঠিক আছে।'
  const bits: string[] = []
  if (p.pendingApprovals > 0) bits.push(`${p.pendingApprovals}টি অনুমোদন বাকি`)
  if ((p.agingApprovals ?? 0) > 0) bits.push(`${p.agingApprovals}টি অনুমোদন ২+ দিন পুরনো (এক্সপায়ার হতে পারে)`)
  if ((p.moneyRequests ?? 0) > 0) bits.push(`${p.moneyRequests}টি ওয়ালেট/অ্যাডভান্স রিকোয়েস্ট বাকি`)
  if ((p.csAlerts ?? 0) > 0) bits.push(`${p.csAlerts}টি কাস্টমার অ্যালার্ট খোলা`)
  if (p.ownerEscalations > 0) bits.push(`${p.ownerEscalations}টি কাজ আপনার নজরে`)
  if (p.openTodos > 0) bits.push(`${p.openTodos}টি খোলা টুডু`)
  return `দেখলাম: ${bits.join(', ')}।`
}

// ── Per-day heartbeat conversation ───────────────────────────────────────────

function ymdDhaka(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)
}

/**
 * One rolling-per-day conversation for the heartbeat, mirroring the day-shift
 * thread. The head's proactive reasoning lands here as normal assistant messages
 * the owner can open and read.
 */
async function getOrCreateHeartbeatConversation(date: string): Promise<string> {
  const key = `${HEARTBEAT_CONV_KEY_PREFIX}${date}`
  const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
  if (row?.value) return row.value

  const conv = await prisma.agentConversation.create({
    data: {
      title: `💓 এজেন্ট হার্টবিট — ${date}`,
      source: 'heartbeat',
      businessId: BUSINESS_ID,
      modelId: 'claude-sonnet-4-6',
    },
  })
  await prisma.agentKvSetting.upsert({
    where: { key },
    create: { key, value: conv.id },
    update: { value: conv.id },
  })
  return conv.id
}

/** The self-check directive the head reacts to when it wakes. */
function buildHeartbeatDirective(pulse: HeartbeatPulse): string {
  return (
    // First line MUST start with HEARTBEAT_WAKE_SENTINEL — the chat keys the inline
    // "ALMA নিজে থেকে জাগল" wake-up divider off it, so this directive never renders
    // as a fake owner message in the owner's live chat.
    `${HEARTBEAT_WAKE_SENTINEL} — তুমি নিজে থেকে জেগেছ, Boss কিছু বলেননি]\n\n` +
    'এই মুহূর্তে ব্যবসার অবস্থা একটু দেখে নাও। সংক্ষিপ্ত ইশারা:\n' +
    `• অনুমোদন-অপেক্ষমাণ কাজ: ${pulse.pendingApprovals}\n` +
    `• ২+ দিন পুরনো অনুমোদন (এক্সপায়ার ঝুঁকি): ${pulse.agingApprovals ?? 0}\n` +
    `• ওয়ালেট/অ্যাডভান্স রিকোয়েস্ট বাকি: ${pulse.moneyRequests ?? 0}\n` +
    `• খোলা কাস্টমার অ্যালার্ট: ${pulse.csAlerts ?? 0}\n` +
    `• তোমার এসকেলেট-করা কাজ (Boss-এর নজরে): ${pulse.ownerEscalations}\n` +
    `• খোলা টুডু: ${pulse.openTodos}\n\n` +
    'প্রয়োজনে নিজের টুল দিয়ে আরও দেখো (অনুমোদন, গ্রাহক, স্টক, নগদ-প্রবাহ, ডেডলাইন)। ' +
    'সত্যিই জরুরি বা সময়োপযোগী কিছু থাকলে — autonomy policy অনুযায়ী — নিজে ব্যবস্থা নাও অথবা ' +
    'Boss-কে সংক্ষেপে (২-৩ লাইনে) জানাও। টাকা বা অপরিবর্তনীয় কাজ নিজে কোরো না; দরকার হলে অনুমোদনের জন্য পাঠাও। ' +
    'করার মতো গুরুত্বপূর্ণ কিছু না থাকলে শুধু এক লাইনে লেখো: "সব ঠিক আছে, Sir।" — অযথা কাজ বানিয়ো না।'
  )
}

/**
 * Where the wake-up turn should land. The owner asked for a "100% Claude Code
 * ScheduleWakeup" feel: the wake-up should appear INLINE at the bottom of whatever
 * chat he currently has open, not in a side thread. So we target the owner's active
 * web/app conversation (his session pointer, else the most-recent main chat) — the
 * app's 12s message poll then floats the turn into his open session automatically.
 *
 * Two guards keep this safe:
 *   • If he is mid-turn in that chat (a turn is `running`), we must NOT inject — it
 *     would interleave with his own conversation. We fall back to the per-day
 *     heartbeat thread so the tick is never lost and never collides.
 *   • Any lookup failure also falls back to the per-day heartbeat thread.
 */
async function resolveWakeConversation(now: Date): Promise<{ id: string; inOwnerChat: boolean }> {
  try {
    let convId = (await getOwnerSessionPointer()).conversationId
    if (convId) {
      const exists = await prisma.agentConversation.findFirst({
        where: { id: convId, archived: false },
        select: { id: true },
      })
      if (!exists) convId = null
    }
    if (!convId) {
      const latest = await prisma.agentConversation.findFirst({
        where: { archived: false, projectId: null, source: 'web' },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      })
      convId = latest?.id ?? null
    }
    if (convId) {
      const turn = await getLatestTurn(convId)
      if (turn?.status !== 'running') return { id: convId, inOwnerChat: true }
    }
  } catch {
    /* fall through to the per-day heartbeat thread */
  }
  return { id: await getOrCreateHeartbeatConversation(ymdDhaka(now)), inOwnerChat: false }
}

/**
 * The model the heartbeat head runs on. By owner decision a self-wake runs on the
 * CHEAP head (DeepSeek), not Sonnet — an autonomous "glance at the business" is
 * routine and shouldn't pay Claude rates every tick. It is passed to runOwnerTurn
 * as an EXPLICIT model id, so the head router runs exactly that model (tier
 * 'explicit' → no triage, no premium-upgrade gate). Safety is unchanged: every
 * mutating action still goes through the owner's approval cards (autonomy policy),
 * and if the head delegates a finance/data-analysis sub-task that CRITICAL tier is
 * still hard-guarded to Claude. Falls back to the default head only if the cheap
 * model is misconfigured/unknown, so a tick never fails to wake. Owner-tunable via
 * CHEAP_HEAD_MODEL_ID (no redeploy).
 */
function heartbeatHeadModelId(): string {
  const cheapId = process.env.CHEAP_HEAD_MODEL_ID?.trim() || 'or-deepseek-v4-flash'
  if (isKnownModelId(cheapId)) {
    const m = getModel(cheapId)
    if (m.provider !== 'anthropic' && m.supportsTools) return cheapId
  }
  return DEFAULT_MODEL_ID
}

// ── The tick ─────────────────────────────────────────────────────────────────

async function wakeHead(
  pulse: HeartbeatPulse,
  now: Date,
): Promise<{ kind: 'active' | 'blocked' | 'error'; summary: string; costUsd: number; conversationId?: string }> {
  let conversationId: string
  try {
    conversationId = (await resolveWakeConversation(now)).id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).agentMessage.create({
      data: { conversationId, role: 'user', content: [{ type: 'text', text: buildHeartbeatDirective(pulse) }] },
    })
  } catch (err) {
    await captureAgentError(err, 'heartbeat_brain', { route: 'heartbeat:seed' })
    return { kind: 'error', summary: 'হার্টবিট চালু করা যায়নি (থ্রেড তৈরি ব্যর্থ)।', costUsd: 0 }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MAX_WAKE_MS)
  let summary = ''
  let costUsd = 0
  let blocked = false
  let error: string | undefined
  try {
    const stream: AsyncGenerator<AgentEvent> = runOwnerTurn(conversationId, {
      businessId: BUSINESS_ID,
      signal: controller.signal,
      // Owner decision: the autonomous heartbeat thinks on the cheap head (DeepSeek),
      // not Sonnet. Explicit id ⇒ head router runs exactly this model (no triage).
      modelId: heartbeatHeadModelId(),
    })
    for await (const ev of stream) {
      switch (ev.type) {
        case 'text_delta':
          summary += ev.delta
          break
        case 'verification_retry':
          summary = ''
          break
        case 'confirm_card':
          blocked = true
          break
        case 'error':
          error = ev.message
          break
        case 'done':
          costUsd = ev.costUsd ?? 0
          break
        default:
          break
      }
    }
  } catch (err) {
    error = controller.signal.aborted ? 'হার্টবিট টার্ন সময়সীমা পেরিয়েছে' : err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }

  const clean = summary.trim()
  if (error && !clean) {
    await captureAgentError(new Error(error), 'heartbeat_brain', { route: 'heartbeat:turn' })
    return { kind: 'error', summary: `হার্টবিট সম্পূর্ণ হয়নি — ${error}`, costUsd, conversationId }
  }
  return {
    kind: blocked ? 'blocked' : 'active',
    summary: clean || (blocked ? 'একটি কাজ আপনার অনুমোদনের জন্য পাঠিয়েছি।' : 'দেখে নিলাম — আলাদা ব্যবস্থার দরকার পড়েনি।'),
    costUsd,
    conversationId,
  }
}

/**
 * Run one heartbeat tick. Safe to call from the cron or a manual trigger.
 * `force` skips the enabled / office-hours / change / cap gates (used by the "test
 * the heartbeat now" control) but still records the tick and respects the head's
 * own autonomy policy.
 */
export async function runHeartbeatTick(opts: { now?: Date; force?: boolean } = {}): Promise<HeartbeatTickResult> {
  const now = opts.now ?? new Date()
  const force = opts.force ?? false

  const quiet = (reason: string): HeartbeatTickResult => ({
    ran: false,
    reason,
    headWoke: false,
    kind: null,
    pulse: null,
    costUsd: 0,
    summary: '',
  })

  if (!isAgentEnabled()) return quiet('agent_disabled')

  const settings = await getHeartbeatSettings()

  // Off-hours is a hard quiet bail for both the enabled and the self-arm paths
  // (the cron only fires during office hours anyway; this guards manual/odd fires).
  if (settings.officeHoursOnly && !isWithinOfficeHours(now) && !force) return quiet('off_hours')

  // SELF-ARMING ("ekdom tomar moto"): when the master switch is OFF, the agent
  // decides for itself whether to wake. If the owner fully stopped it (autoArm off)
  // we stay a no-op. Otherwise we take the cheap pulse and ARM ONLY when real work
  // is pending — turning the master switch on ourselves and attending to it, exactly
  // like Claude scheduling its own wake-up when work remains. Nothing pending ⇒ keep
  // resting (near-free). `armedNow` lets this fresh wake bypass change-detection, so
  // pending work that was already there still gets attended on the tick we arm.
  let armedNow = false
  if (!settings.enabled && !force) {
    if (!settings.autoArm) return quiet('disabled')
    const probe = await gatherPulse()
    if (!pulseIsActionable(probe)) return quiet('resting')
    await setHeartbeatSettings({ enabled: true })
    await recordHeartbeat({
      kind: 'idle',
      pulse: probe,
      headWoke: false,
      summary: `🤖 কাজ বাকি দেখে নিজে থেকে হার্টবিট চালু করলাম — ${describePulse(probe)}`,
    }).catch(() => {})
    armedNow = true
  }

  const pulse = await gatherPulse()

  try {
    // Gate: only wake the head when the picture actually changed to something
    // actionable, and we're under the daily cost cap. Otherwise log a quiet tick.
    const last = await lastHeartbeat()
    const changed = !last || pulseFingerprint(pulse) !== pulseFingerprint(last.pulse)
    const actionable = pulseIsActionable(pulse)
    const wakes = await headWakesToday(now)
    const underCap = wakes < settings.dailyHeadWakeCap

    // A fresh self-arm (armedNow) attends to the pending work even if the pulse
    // looks "unchanged" vs the last tick — arming IS the signal that work is waiting.
    const shouldWake = force || (actionable && underCap && (changed || armedNow))

    if (!shouldWake) {
      const reason = !actionable ? 'quiet' : !changed ? 'unchanged' : !underCap ? 'cap_reached' : 'quiet'
      const entry = await recordHeartbeat({
        kind: 'idle',
        pulse,
        headWoke: false,
        summary:
          reason === 'cap_reached'
            ? `${describePulse(pulse)} (আজকের হার্টবিট-সীমা পূর্ণ — পরে দেখব)`
            : describePulse(pulse),
      })
      return {
        ran: true,
        reason,
        headWoke: false,
        kind: entry?.kind ?? 'idle',
        pulse,
        costUsd: 0,
        summary: entry?.summary ?? '',
      }
    }

    const result = await wakeHead(pulse, now)
    await recordHeartbeat({
      kind: result.kind,
      pulse,
      headWoke: true,
      summary: result.summary,
      costUsd: result.costUsd,
      conversationId: result.conversationId,
    })
    return {
      ran: true,
      reason: force ? 'forced' : 'woke',
      headWoke: true,
      kind: result.kind,
      pulse,
      costUsd: result.costUsd,
      summary: result.summary,
    }
  } catch (err) {
    await captureAgentError(err, 'heartbeat_brain', { route: 'heartbeat:tick' })
    await recordHeartbeat({ kind: 'error', pulse, headWoke: false, summary: 'হার্টবিট টিক ব্যর্থ হয়েছে।' }).catch(() => {})
    return { ran: true, reason: 'error', headWoke: false, kind: 'error', pulse, costUsd: 0, summary: 'হার্টবিট টিক ব্যর্থ হয়েছে।' }
  }
}
