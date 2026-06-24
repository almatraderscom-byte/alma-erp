/**
 * Office supervisor — the autonomous DeepSeek agent that watches staff tasks.
 *
 * Runs on a Vercel cron during office hours only (09:30–20:00 Asia/Dhaka). Each
 * tick it processes the business's active tasks and, per the owner's plan:
 *   1. Auto-verifies the ~90% it can confirm (image proof via the existing
 *      vision assessor; text/link proof via a DeepSeek judgment; FB/ERP machine
 *      checks closed straight away) → task done, no owner needed.
 *   2. Asks the staff for an update in the office group when a task is taking
 *      longer than normal (overdue vs. its deadline, or idle too long).
 *   3. When it can't understand how to supervise a task it asks the staff a
 *      clarifying question — up to TWICE.
 *
 * Phase-3 90/10 gate: whenever the agent can't confirm or understand a task it
 * does NOT bother the owner by default. It weighs the task's criticality
 * (assessCriticality: money/customer types + keywords, repeated rework, or the
 * owner's "always escalate" flag). Only the critical ~10% escalate to the owner;
 * low-stakes ones are accepted as done (clearly logged as unverified-accept) or
 * quietly left for the staff. This keeps the owner's review queue to the few
 * things that genuinely need him.
 *
 * The supervisor's reasoning/coordination runs on DeepSeek (or-deepseek-v4-flash,
 * the `ops` model) per the locked owner decision — never the head/Claude. The
 * narrow vision proof check is delegated to the existing Claude assessor route.
 *
 * Everything here is best-effort and idempotent: a model/network failure must
 * never close or escalate a task wrongly — on doubt it leaves the task alone or
 * hands it to the owner.
 */
import { prisma } from '@/lib/prisma'
import { adapterFor } from '@/agent/lib/models/adapters'
import { getModel } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'
import { captureAgentError } from '@/agent/lib/sentry'
import { resilientFetch } from '@/agent/lib/fetch-retry'
import { postGroupMessage } from '@/agent/lib/office-chat'
import {
  agentAutoVerify,
  agentAcceptUnverified,
  agentRequestRedo,
  escalateToOwner,
  requestUpdate,
} from '@/agent/lib/office-actions'
import { raiseProposal } from '@/agent/lib/office-proposals'

/** Locked to DeepSeek per owner decision — the same model the `ops` specialist uses. */
const SUPERVISOR_MODEL_ID = 'or-deepseek-v4-flash'

const TZ = 'Asia/Dhaka'
/** Office hours, minutes-of-day in Dhaka: 09:30 → 20:00 inclusive. */
const OFFICE_START_MIN = 9 * 60 + 30
const OFFICE_END_MIN = 20 * 60

const MAX_CLARIFY = 2
/** A task with no deadline is "taking longer than normal" after this idle gap. */
const NORMAL_IDLE_MS = 4 * 60 * 60 * 1000
/** Don't re-ask for an update within this window of the last request. */
const FOLLOWUP_COOLDOWN_MS = 90 * 60 * 1000
/** After this many redo rounds, stop auto-redoing and let the owner decide. */
const MAX_AUTO_REDO = 2

const MAX_TASKS_PER_TICK = 14
const MAX_LLM_CALLS_PER_TICK = 8
const LLM_TIMEOUT_MS = 20_000

const SUPERVISOR_SYSTEM =
  'তুমি ALMA Lifestyle অফিসের সুপারভাইজার এজেন্ট। তুমি স্টাফদের কাজ তদারকি করো, যাচাই করো, ' +
  'আর দরকার হলে ভদ্রভাবে আপডেট বা স্পষ্টতা চাও — সবসময় বাংলায়, ইসলামি সৌজন্য বজায় রেখে, স্টাফকে সম্মানের সাথে। ' +
  'তুমি শুধু নির্দেশ অনুযায়ী JSON আউটপুট দেবে, কোনো অতিরিক্ত লেখা নয়।'

export type SupervisorTickResult = {
  businessId: string
  ran: boolean
  withinHours: boolean
  considered: number
  verified: number
  /** Low-stakes tasks the agent accepted without full verification (90/10 gate). */
  accepted: number
  redo: number
  escalated: number
  clarified: number
  followedUp: number
  skipped: number
}

// ── Office-hours gate ────────────────────────────────────────────────────────

/** Minutes-of-day in Dhaka for the given instant. */
function dhakaMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  // Intl may emit "24" for midnight in some runtimes; normalize.
  const hour = h === 24 ? 0 : h
  return hour * 60 + m
}

/** True only during office hours (09:30–20:00 Asia/Dhaka). */
export function isWithinOfficeHours(now: Date = new Date()): boolean {
  const mins = dhakaMinutesOfDay(now)
  return mins >= OFFICE_START_MIN && mins <= OFFICE_END_MIN
}

// ── DeepSeek helper ──────────────────────────────────────────────────────────

async function deepseekJson<T>(user: string, dedupKey: string): Promise<T | null> {
  let model
  try {
    model = getModel(SUPERVISOR_MODEL_ID)
  } catch {
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  try {
    const adapter = adapterFor(model.provider)
    for await (const ev of adapter.streamTurn({
      apiModel: model.apiModel,
      system: SUPERVISOR_SYSTEM,
      messages: [{ role: 'user', content: user }],
      tools: [],
      thinking: 'none',
      signal: controller.signal,
    })) {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'usage') {
        inputTokens = ev.inputTokens
        outputTokens = ev.outputTokens
      }
    }
  } catch (err) {
    void captureAgentError(err, 'office_supervisor', { route: 'office-supervisor' })
    return null
  } finally {
    clearTimeout(timer)
  }

  if (inputTokens > 0 || outputTokens > 0) {
    try {
      const costUsd = calcModelTurnCostUsd(model, { inputTokens, outputTokens })
      await logCost({
        provider: 'openrouter',
        kind: 'chat',
        units: { inputTokens, outputTokens, model: model.apiModel, role: 'office_supervisor' },
        costUsd,
        dedupKey,
      })
    } catch {
      /* cost logging is best-effort */
    }
  }

  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as T
  } catch {
    return null
  }
}

// ── Proof helpers ────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function proofImageUrl(data: Record<string, unknown> | null): string | null {
  if (!data) return null
  for (const k of ['imageUrl', 'image', 'photo', 'url', 'fileUrl']) {
    const v = data[k]
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  }
  return null
}

function proofText(data: Record<string, unknown> | null): string {
  if (!data) return ''
  for (const k of ['text', 'caption', 'note', 'link', 'message']) {
    const v = data[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function appBaseUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'https://alma-erp-six.vercel.app'
  ).replace(/\/$/, '')
}

/** Ask the existing Claude vision assessor whether the image proof matches the task. */
async function assessImageProof(task: TaskRow, imageUrl: string): Promise<{ matches: boolean; confidence: 'high' | 'low'; note: string } | null> {
  const token = process.env.AGENT_INTERNAL_TOKEN
  if (!token) return null
  try {
    const res = await resilientFetch(`${appBaseUrl()}/api/assistant/internal/assess-task-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        taskTitle: task.title,
        taskDetail: task.detail ?? '',
        taskType: task.type,
        proofImageUrl: imageUrl,
      }),
      timeoutMs: 25_000,
      retries: 1,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { matches?: boolean; confidence?: string; note?: string }
    return {
      matches: json.matches !== false,
      confidence: json.confidence === 'high' ? 'high' : 'low',
      note: typeof json.note === 'string' ? json.note : '',
    }
  } catch {
    return null
  }
}

// ── Task processing ──────────────────────────────────────────────────────────

type StaffLite = {
  id: string
  name: string
  telegramChatId: string | null
  ntfyTopic: string | null
  userId: string | null
}
type TaskRow = {
  id: string
  title: string
  detail: string | null
  type: string
  status: string
  verificationStatus: string
  proofType: string | null
  proofData: unknown
  redoCount: number
  dueAt: Date | null
  createdAt: Date
  updateRequestedAt: Date | null
  lastStaffUpdateAt: Date | null
  supervisorClarifyCount: number
  supervisorLastTickAt: Date | null
  supervisorAlwaysEscalate: boolean
  businessId: string
  staff: StaffLite
}

const ACTIVE_STATUSES = ['sent', 'approved', 'carried', 'awaiting_proof'] as const

// ── 90/10 criticality gate ───────────────────────────────────────────────────
// Only the truly-critical ~10% of tasks should reach the owner when the agent
// can't fully confirm them. Everything else the supervisor resolves itself.

/** Task types that are inherently owner-critical (money / customer-facing). */
const CRITICAL_TYPES = new Set(['finance', 'payment', 'order', 'delivery', 'inventory', 'cs', 'customer'])
/** Bangla + English keywords that mark a task as money/customer critical. */
const CRITICAL_KEYWORDS =
  /(টাকা|পেমেন্ট|পরিশোধ|ইনভয়েস|বিল|অর্ডার|ডেলিভারি|কুরিয়ার|কাস্টমার|গ্রাহক|ক্রেতা|ব্যাংক|বিকাশ|নগদ|লেনদেন|রিফান্ড|ফেরত|অভিযোগ|payment|invoice|order|delivery|refund|customer|complaint|bank|money|cash)/i
/** Repeated rework on the same task is a signal something is genuinely wrong. */
const CRITICAL_REDO = 3

/** Decide whether an unverifiable/unclear task is critical enough for the owner. */
function assessCriticality(task: TaskRow): { critical: boolean; reason: string } {
  if (task.supervisorAlwaysEscalate) return { critical: true, reason: 'মালিক এই কাজটি সবসময় দেখতে চেয়েছেন' }
  if (CRITICAL_TYPES.has(task.type)) return { critical: true, reason: 'অর্থ/গ্রাহক সম্পর্কিত কাজ' }
  const hay = `${task.title} ${task.detail ?? ''}`
  if (CRITICAL_KEYWORDS.test(hay)) return { critical: true, reason: 'অর্থ/গ্রাহক সম্পর্কিত কাজ' }
  if ((task.redoCount ?? 0) >= CRITICAL_REDO) return { critical: true, reason: 'বারবার সংশোধন লেগেছে' }
  return { critical: false, reason: '' }
}

/**
 * Gate for the "couldn't verify, but staff submitted work" case. Critical →
 * owner; non-critical low-stakes → accept as done (clearly logged). Returns the
 * outcome label for the tick counters.
 */
async function handoffSubmitted(task: TaskRow, reason: string): Promise<'escalated' | 'accepted'> {
  const crit = assessCriticality(task)
  if (crit.critical) {
    await escalateToOwner(task.id, task.businessId, reason)
    return 'escalated'
  }
  await agentAcceptUnverified(task.id, task.businessId, `যাচাই করা যায়নি, কম-ঝুঁকির কাজ — ${reason}`)
  return 'accepted'
}

// ── Penalty / reward proposals (owner approves; agent never touches payroll) ──

/** Rework this many times or more on one task → propose a penalty for the owner. */
const PENALTY_REDO_THRESHOLD = 3

/**
 * After verifying a task, raise a penalty or reward proposal when the signal is
 * strong enough. Idempotent per (task, kind); best-effort (never blocks a tick).
 */
async function maybeRaiseProposals(task: TaskRow, outcome: string, now: Date): Promise<void> {
  // Penalty: the same task bounced back too many times.
  if ((task.redoCount ?? 0) >= PENALTY_REDO_THRESHOLD) {
    await raiseProposal({
      businessId: task.businessId,
      staffId: task.staff.id,
      taskId: task.id,
      kind: 'penalty',
      reason: `"${task.title}" — একই কাজ ${task.redoCount} বার সংশোধন করতে হয়েছে`,
      meta: { redoCount: task.redoCount },
    })
    return
  }
  // Reward: a confident, first-try, on-time completion.
  if (
    outcome === 'verified' &&
    (task.redoCount ?? 0) === 0 &&
    task.dueAt &&
    now.getTime() <= task.dueAt.getTime()
  ) {
    await raiseProposal({
      businessId: task.businessId,
      staffId: task.staff.id,
      taskId: task.id,
      kind: 'reward',
      reason: `"${task.title}" — সময়ের মধ্যে প্রথম চেষ্টাতেই নির্ভুল কাজ`,
      meta: { onTime: true },
    })
  }
}

/** Does this task need a "how's it going?" nudge right now? */
function needsFollowUp(task: TaskRow, now: Date): boolean {
  if (task.status === 'done') return false
  const nowMs = now.getTime()
  const reqAt = task.updateRequestedAt?.getTime()
  const lastUpd = task.lastStaffUpdateAt?.getTime()
  // An update was already requested and not yet answered → keep waiting.
  if (reqAt && (!lastUpd || lastUpd < reqAt)) return false
  // Respect the cooldown after the last request.
  if (reqAt && nowMs - reqAt < FOLLOWUP_COOLDOWN_MS) return false
  const overdue = task.dueAt ? nowMs > task.dueAt.getTime() : false
  const baseline = lastUpd ?? task.createdAt.getTime()
  const idleTooLong = nowMs - baseline > NORMAL_IDLE_MS
  return overdue || idleTooLong
}

/** Verify a task whose proof the staff has already submitted. Returns the action taken. */
async function verifySubmittedProof(
  task: TaskRow,
  budget: { llm: number },
): Promise<'verified' | 'accepted' | 'redo' | 'escalated' | 'skipped'> {
  const data = asRecord(task.proofData)
  const imageUrl = proofImageUrl(data)
  const text = proofText(data)

  // Image proof → existing Claude vision assessor.
  if (imageUrl && budget.llm > 0) {
    budget.llm--
    const verdict = await assessImageProof(task, imageUrl)
    if (!verdict) {
      // Couldn't assess → critical to owner, low-stakes accepted (90/10 gate).
      return handoffSubmitted(task, 'ছবি যাচাই করা যায়নি')
    }
    if (verdict.matches && verdict.confidence === 'high') {
      await agentAutoVerify(task.id, task.businessId, { evidence: verdict.note || 'ছবি যাচাই হয়েছে', method: 'vision' })
      return 'verified'
    }
    if (!verdict.matches && verdict.confidence === 'high') {
      if ((task.redoCount ?? 0) >= MAX_AUTO_REDO) {
        return handoffSubmitted(task, `বারবার যাচাই ব্যর্থ — ${verdict.note || ''}`.trim())
      }
      await agentRequestRedo(task.id, task.businessId, verdict.note || 'কাজটি কাজের সাথে মিলছে না — আবার পাঠান')
      return 'redo'
    }
    // Unsure.
    return handoffSubmitted(task, verdict.note || 'এজেন্ট নিশ্চিত হতে পারেনি')
  }

  // Text / link proof → DeepSeek judgment.
  if (text && budget.llm > 0) {
    budget.llm--
    const judged = await deepseekJson<{ verdict?: string; reason?: string }>(
      `কাজ: ${task.title}${task.detail ? ` — ${task.detail}` : ''}\n` +
        `স্টাফের জমা দেওয়া প্রমাণ: ${text.slice(0, 1500)}\n\n` +
        `প্রমাণটি কি কাজটি সম্পন্ন হয়েছে তা নিশ্চিত করে? শুধু JSON দাও: ` +
        `{"verdict":"pass"|"fail"|"unsure","reason":"এক লাইনে বাংলা"}`,
      `supervisor_verify:${task.id}:${task.redoCount}`,
    )
    if (!judged) {
      return handoffSubmitted(task, 'প্রমাণ যাচাই করা যায়নি')
    }
    if (judged.verdict === 'pass') {
      await agentAutoVerify(task.id, task.businessId, { evidence: judged.reason || 'প্রমাণ যাচাই হয়েছে', method: 'text' })
      return 'verified'
    }
    if (judged.verdict === 'fail') {
      if ((task.redoCount ?? 0) >= MAX_AUTO_REDO) {
        return handoffSubmitted(task, `বারবার যাচাই ব্যর্থ — ${judged.reason || ''}`.trim())
      }
      await agentRequestRedo(task.id, task.businessId, judged.reason || 'প্রমাণ যথেষ্ট নয় — আবার পাঠান')
      return 'redo'
    }
    return handoffSubmitted(task, judged.reason || 'এজেন্ট নিশ্চিত হতে পারেনি')
  }

  // No usable proof, or LLM budget exhausted → gate decides owner vs. accept.
  if (!imageUrl && !text) {
    return handoffSubmitted(task, 'প্রমাণ পাওয়া যায়নি')
  }
  return 'skipped'
}

/** Decide whether the supervisor understands the task; ask / escalate as needed. */
async function triageUnderstanding(
  task: TaskRow,
  now: Date,
  budget: { llm: number },
): Promise<'understood' | 'clarified' | 'escalated' | 'deferred' | 'skipped'> {
  if (budget.llm <= 0) return 'skipped'
  budget.llm--
  const judged = await deepseekJson<{ clear?: boolean; question?: string }>(
    `একটি স্টাফকে দেওয়া কাজ:\n` +
      `শিরোনাম: ${task.title}\n` +
      `বিস্তারিত: ${task.detail ?? '(নেই)'}\n` +
      `ধরন: ${task.type}\n\n` +
      `তুমি কি বুঝতে পারছ কাজটি ঠিকঠাক হয়েছে কিনা পরে যাচাই করার জন্য কী দরকার? ` +
      `যদি স্পষ্ট হয় clear=true দাও। যদি অস্পষ্ট হয়, স্টাফকে করার মতো একটি ছোট বাংলা প্রশ্ন দাও। ` +
      `শুধু JSON: {"clear":true|false,"question":"স্টাফকে প্রশ্ন (অস্পষ্ট হলে)"}`,
    `supervisor_triage:${task.id}:${task.supervisorClarifyCount}`,
  )

  // On model failure, assume clear — never spam-clarify on uncertainty.
  if (!judged || judged.clear !== false) {
    await prisma.agentStaffTask.update({ where: { id: task.id }, data: { supervisorLastTickAt: now } })
    return 'understood'
  }

  // Unclear after asking MAX_CLARIFY times → 90/10 gate: only critical tasks go
  // to the owner; for low-stakes ones the agent stops nagging and lets the staff
  // get on with it (it'll verify the proof when submitted).
  if ((task.supervisorClarifyCount ?? 0) >= MAX_CLARIFY) {
    const crit = assessCriticality(task)
    if (crit.critical) {
      await escalateToOwner(task.id, task.businessId, 'এজেন্ট কাজটি বুঝতে পারেনি — Boss যাচাই করবেন')
      return 'escalated'
    }
    await prisma.agentStaffTask.update({
      where: { id: task.id },
      data: { supervisorLastTickAt: now, supervisorCriticality: 'normal' },
    })
    return 'deferred'
  }

  const question = (judged.question ?? '').trim() || `${task.staff.name} ভাই, "${task.title}" কাজটি ঠিক কীভাবে করছেন একটু বুঝিয়ে বলবেন?`
  await postGroupMessage({ authorType: 'agent', body: question, taskRef: task.id, businessId: task.businessId })
  await requestUpdate(task.id, task.businessId, { note: question, by: 'agent' })
  await prisma.agentStaffTask.update({
    where: { id: task.id },
    data: { supervisorClarifyCount: (task.supervisorClarifyCount ?? 0) + 1, supervisorLastTickAt: now },
  })
  return 'clarified'
}

/** Post a "how's it going?" nudge to the office group and start the update clock. */
async function askForUpdate(task: TaskRow, now: Date): Promise<void> {
  const overdue = task.dueAt ? now.getTime() > task.dueAt.getTime() : false
  const body = overdue
    ? `${task.staff.name} ভাই, "${task.title}" কাজটির সময় পেরিয়ে যাচ্ছে — কী অবস্থা একটু জানান তো? 🙏`
    : `${task.staff.name} ভাই, "${task.title}" কাজটির কী অবস্থা? একটু আপডেট দিন 🙏`
  await postGroupMessage({ authorType: 'agent', body, taskRef: task.id, businessId: task.businessId })
  await requestUpdate(task.id, task.businessId, { note: body, by: 'agent' })
}

// ── Attendance / leave presence gate (read-only) ─────────────────────────────

/**
 * Build a `(staffId) => working today?` predicate from ERP attendance + leave.
 * - On approved leave today → not working.
 * - Linked to an ERP user: working only if checked in and not yet checked out.
 * - Not linked to a user (can't check in) → assume working (can't tell).
 * Read-only; failures degrade to "assume working" so the supervisor still runs.
 */
async function buildPresenceGate(businessId: string, now: Date): Promise<(staffId: string) => boolean> {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now) // YYYY-MM-DD (Dhaka)
  const todayDate = new Date(`${ymd}T00:00:00Z`)

  try {
    const [staff, attendance, leaves] = await Promise.all([
      prisma.agentStaff.findMany({ where: { businessId, active: true }, select: { id: true, userId: true } }),
      prisma.attendanceRecord.findMany({
        where: { businessId, attendanceDate: todayDate },
        select: { userId: true, checkInAt: true, checkOutAt: true },
      }),
      prisma.staffLeave.findMany({
        where: { businessId, status: 'approved', startDate: { lte: ymd }, endDate: { gte: ymd } },
        select: { staffId: true },
      }),
    ])

    const presenceByUser = new Map<string, { in: boolean; out: boolean }>()
    for (const a of attendance) {
      if (!a.userId) continue
      presenceByUser.set(a.userId, { in: Boolean(a.checkInAt), out: Boolean(a.checkOutAt) })
    }
    const onLeave = new Set(leaves.map((l) => l.staffId))
    const userByStaff = new Map(staff.map((s) => [s.id, s.userId]))

    return (staffId: string): boolean => {
      if (onLeave.has(staffId)) return false
      const uid = userByStaff.get(staffId)
      if (!uid) return true // not linked → can't tell, assume working
      const p = presenceByUser.get(uid)
      if (!p) return false // linked but no check-in record today → not in yet
      return p.in && !p.out
    }
  } catch {
    return () => true // degrade gracefully
  }
}

// ── Main tick ────────────────────────────────────────────────────────────────

export async function runSupervisorTick(
  args: { businessId?: string; now?: Date } = {},
): Promise<SupervisorTickResult> {
  const businessId = args.businessId ?? 'ALMA_LIFESTYLE'
  const now = args.now ?? new Date()

  const base: SupervisorTickResult = {
    businessId,
    ran: true,
    withinHours: true,
    considered: 0,
    verified: 0,
    accepted: 0,
    redo: 0,
    escalated: 0,
    clarified: 0,
    followedUp: 0,
    skipped: 0,
  }

  if (!isWithinOfficeHours(now)) {
    return { ...base, ran: false, withinHours: false }
  }

  const rows = await prisma.agentStaffTask.findMany({
    where: {
      businessId,
      supervisorNeedsOwner: false,
      status: { in: [...ACTIVE_STATUSES] },
    },
    orderBy: [{ verificationStatus: 'desc' }, { createdAt: 'asc' }], // proof_submitted first
    take: MAX_TASKS_PER_TICK,
    select: {
      id: true,
      title: true,
      detail: true,
      type: true,
      status: true,
      verificationStatus: true,
      proofType: true,
      proofData: true,
      redoCount: true,
      dueAt: true,
      createdAt: true,
      updateRequestedAt: true,
      lastStaffUpdateAt: true,
      supervisorClarifyCount: true,
      supervisorLastTickAt: true,
      supervisorAlwaysEscalate: true,
      businessId: true,
      staff: { select: { id: true, name: true, telegramChatId: true, ntfyTopic: true, userId: true } },
    },
  })

  base.considered = rows.length
  const budget = { llm: MAX_LLM_CALLS_PER_TICK }

  // Latest staff group message — used to decide if a clarify warrants a re-ask.
  const latestStaffMsg = await prisma.officeGroupMessage.findFirst({
    where: { businessId, authorType: 'staff', status: 'posted' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  const latestStaffMsgAt = latestStaffMsg?.createdAt?.getTime() ?? 0

  // Attendance / leave (read-only): don't nag a staff member who isn't working
  // today. Verification of already-submitted proof still runs regardless.
  const isStaffWorking = await buildPresenceGate(businessId, now)

  for (const row of rows) {
    const task = row as unknown as TaskRow

    // 1) Proof submitted → verify (the bulk of the 90%).
    if (task.verificationStatus === 'proof_submitted') {
      const outcome = await verifySubmittedProof(task, budget)
      if (outcome === 'verified') base.verified++
      else if (outcome === 'accepted') base.accepted++
      else if (outcome === 'redo') base.redo++
      else if (outcome === 'escalated') base.escalated++
      else base.skipped++
      await maybeRaiseProposals(task, outcome, now)
      continue
    }

    // 2) Machine-checked (FB/ERP) and awaiting close → close it.
    if (task.verificationStatus === 'auto_verified' && task.status !== 'done') {
      await agentAutoVerify(task.id, businessId, { evidence: 'স্বয়ংক্রিয় যাচাই (FB/ERP)', method: task.proofType ?? 'auto' })
      base.verified++
      continue
    }

    // Attendance gate: from here on we'd nag the staff (clarify / follow-up).
    // If they're not working today (on leave, or not checked in) skip nagging —
    // proof verification above already ran regardless.
    if (!isStaffWorking(task.staff.id)) {
      base.skipped++
      continue
    }

    // 3) In-progress task → understand (clarify-twice) then follow up.
    const clarifyCount = task.supervisorClarifyCount ?? 0
    const lastTick = task.supervisorLastTickAt?.getTime() ?? 0
    const neverTriaged = !task.supervisorLastTickAt
    // Re-triage only when mid-clarification AND the staff has since said something.
    const staffRepliedSinceClarify = clarifyCount > 0 && clarifyCount < MAX_CLARIFY && latestStaffMsgAt > lastTick

    if (neverTriaged || staffRepliedSinceClarify) {
      const outcome = await triageUnderstanding(task, now, budget)
      if (outcome === 'clarified') {
        base.clarified++
        continue
      }
      if (outcome === 'escalated') {
        base.escalated++
        continue
      }
      if (outcome === 'deferred') {
        base.skipped++
        continue
      }
      // 'understood' or 'skipped' → fall through to follow-up.
    } else if (clarifyCount > 0 && clarifyCount < MAX_CLARIFY) {
      // Asked already, still waiting for the staff's answer → don't nag.
      base.skipped++
      continue
    }

    // 4) Follow up if the task is taking longer than normal.
    if (needsFollowUp(task, now)) {
      await askForUpdate(task, now)
      base.followedUp++
    } else {
      base.skipped++
    }
  }

  return base
}
