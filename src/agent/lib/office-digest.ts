/**
 * Owner office digest (Phase 3).
 *
 * A once-a-day, plain-Bangla wrap-up of the office the owner can read at a glance
 * — how many tasks finished, what's still open, what the agent handled on its own
 * (the 90%), what it escalated to him (the ~10%), and any pending penalty/reward
 * proposals waiting on his decision. Pushed to Telegram and also returned so the
 * office section can show the same summary. Read-only: it never mutates a task or
 * touches money — it only reports.
 */
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL } from '@/agent/config'
import { pushOwnerPing } from '@/agent/lib/office-notify'
import { listPendingProposals } from '@/agent/lib/office-proposals'
import { computeStaffPerformance } from '@/agent/lib/office-performance'
import { logCost } from '@/agent/lib/cost-events'
import { getModel } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'

/**
 * The owner's end-of-day report is owner-facing Bangla prose, so it stays on
 * Claude (best Bangla, and it runs only once a day → negligible cost). The head
 * talks to Claude directly (the worker adapters don't cover Anthropic), so we use
 * the Anthropic SDK here exactly like `morale-message.ts`. On any failure we fall
 * back to the structured template text, so the cron never breaks.
 */
const DIGEST_MAX_TOKENS = 700

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}

/** Dhaka-local YYYY-MM-DD for the given instant. */
function dhakaYmd(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(now)
}

export type OwnerDigest = {
  date: string
  /** Bangla pretty date, e.g. "২৪ জুন, মঙ্গলবার". */
  label: string
  total: number
  done: number
  active: number
  /** Awaiting owner review (proof submitted / auto-verified not yet approved). */
  pendingReview: number
  /** Tasks the supervisor escalated to the owner (the ~10%). */
  escalated: number
  /** Low-stakes tasks the agent accepted without full verification. */
  accepted: number
  /** Open update requests the staff hasn't answered. */
  awaitingUpdate: number
  /** Pending penalty/reward proposals awaiting the owner's decision. */
  proposals: number
  /** Best performer this week, if any. */
  topPerformer: { name: string; done: number } | null
  /** Attendance roll-up for the day (ERP face check-in). */
  attendance: {
    /** Staff linked to an ERP user (i.e. able to check in at all). */
    roster: number
    present: number
    absent: number
    late: number
    /** Checked in but not yet checked out at report time. */
    stillIn: number
    /** Names of late arrivals, with minutes late. */
    lateNames: { name: string; min: number }[]
    /** Names of linked staff who never checked in. */
    absentNames: string[]
  }
  /** Lunch roll-up for the day. */
  lunch: {
    took: number
    overruns: number
    /** Names of staff who exceeded the 45-min lunch, with their duration. */
    overrunNames: { name: string; min: number }[]
  }
  /** The structured Bangla message (template — also the narrative fallback). */
  text: string
  /** LLM-written warm "Boss, …" narrative (null until generated; falls back to `text`). */
  narrative: string | null
}

function bnDayLabel(ymd: string): string {
  const d = new Date(`${ymd}T06:00:00Z`)
  const dm = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long' }).format(d)
  const wd = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', weekday: 'long' }).format(d)
  return `${dm}, ${wd}`
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Build the owner's end-of-day office digest for the current (or given) Dhaka day. */
export async function buildOwnerDigest(
  businessId = 'ALMA_LIFESTYLE',
  now: Date = new Date(),
): Promise<OwnerDigest> {
  const ymd = dhakaYmd(now)
  const todayDate = new Date(`${ymd}T00:00:00Z`)

  const [todayTasks, updateRows, proposals, performance, staffList, attendanceRows, lunchRows] = await Promise.all([
    prisma.agentStaffTask.findMany({
      where: { businessId, proposedFor: todayDate },
      select: {
        status: true,
        verificationStatus: true,
        supervisorNeedsOwner: true,
        escalatedAt: true,
        proofData: true,
      },
    }),
    prisma.agentStaffTask.findMany({
      where: { businessId, status: { not: 'done' }, updateRequestedAt: { not: null } },
      select: { updateRequestedAt: true, lastStaffUpdateAt: true },
    }),
    listPendingProposals(businessId),
    computeStaffPerformance(businessId),
    // Active staff + their ERP user link (only linked staff can face check-in).
    prisma.agentStaff.findMany({
      where: { businessId, active: true },
      select: { id: true, name: true, userId: true },
    }),
    // Today's attendance (ERP face check-in). attendanceDate is the UTC-midnight
    // of the Dhaka calendar day, which equals todayDate — exact match is correct.
    prisma.attendanceRecord.findMany({
      where: { businessId, attendanceDate: todayDate },
      select: { userId: true, checkInAt: true, checkOutAt: true, lateMinutes: true },
    }),
    prisma.staffLunch.findMany({
      where: { businessId, lunchDate: ymd },
      select: { staffId: true, staffName: true, durationMin: true, overage: true, endedAt: true },
    }),
  ])

  // ── Attendance roll-up ──────────────────────────────────────────────────────
  const attByUser = new Map<string, { checkInAt: Date | null; checkOutAt: Date | null; lateMinutes: number }>()
  for (const r of attendanceRows) {
    if (!r.userId) continue
    attByUser.set(r.userId, { checkInAt: r.checkInAt ?? null, checkOutAt: r.checkOutAt ?? null, lateMinutes: r.lateMinutes ?? 0 })
  }
  const linkedStaff = staffList.filter((s) => Boolean(s.userId))
  const lateNames: { name: string; min: number }[] = []
  const absentNames: string[] = []
  let present = 0
  let stillIn = 0
  for (const s of linkedStaff) {
    const att = s.userId ? attByUser.get(s.userId) : undefined
    if (att?.checkInAt) {
      present += 1
      if (!att.checkOutAt) stillIn += 1
      if (att.lateMinutes > 0) lateNames.push({ name: s.name, min: att.lateMinutes })
    } else {
      absentNames.push(s.name)
    }
  }
  lateNames.sort((a, b) => b.min - a.min)
  const attendance = {
    roster: linkedStaff.length,
    present,
    absent: absentNames.length,
    late: lateNames.length,
    stillIn,
    lateNames: lateNames.slice(0, 6),
    absentNames: absentNames.slice(0, 6),
  }

  // ── Lunch roll-up ───────────────────────────────────────────────────────────
  const lunchByStaff = new Map<string, { name: string | null; durationMin: number | null; overage: boolean; endedAt: Date | null }>()
  for (const l of lunchRows) {
    // One staff may have multiple rows; keep the longest / overrun one.
    const prev = lunchByStaff.get(l.staffId)
    if (!prev || (l.durationMin ?? 0) > (prev.durationMin ?? 0)) {
      lunchByStaff.set(l.staffId, { name: l.staffName, durationMin: l.durationMin, overage: l.overage, endedAt: l.endedAt })
    }
  }
  const nameByStaffId = new Map(staffList.map((s) => [s.id, s.name]))
  const overrunNames: { name: string; min: number }[] = []
  for (const [sid, l] of lunchByStaff) {
    if (l.overage || (l.durationMin ?? 0) > 45) {
      overrunNames.push({ name: l.name ?? nameByStaffId.get(sid) ?? 'অজানা', min: l.durationMin ?? 0 })
    }
  }
  overrunNames.sort((a, b) => b.min - a.min)
  const lunch = {
    took: lunchByStaff.size,
    overruns: overrunNames.length,
    overrunNames: overrunNames.slice(0, 6),
  }

  // Open update requests = asked, and the staff hasn't answered since.
  const awaitingUpdate = updateRows.filter(
    (t) => t.updateRequestedAt && !(t.lastStaffUpdateAt && t.lastStaffUpdateAt.getTime() >= t.updateRequestedAt.getTime()),
  ).length

  const total = todayTasks.length
  const done = todayTasks.filter((t) => t.status === 'done').length
  const active = todayTasks.filter((t) => t.status !== 'done').length
  const pendingReview = todayTasks.filter(
    (t) => t.verificationStatus === 'proof_submitted' || (t.verificationStatus === 'auto_verified' && t.status !== 'done'),
  ).length
  const escalated = todayTasks.filter((t) => t.supervisorNeedsOwner || t.escalatedAt).length
  const accepted = todayTasks.filter(
    (t) => t.verificationStatus === 'auto_verified' && asRecord(t.proofData)?.agentMethod === 'accepted_unverified',
  ).length

  const top = performance.find((p) => p.done > 0) ?? null
  const topPerformer = top ? { name: top.staffName, done: top.done } : null

  const label = bnDayLabel(ymd)
  const lateTail = attendance.lateNames.length > 0 ? ` (${attendance.lateNames.map((l) => `${l.name} ${bn(l.min)} মি.`).join(', ')})` : ''
  const absentTail = attendance.absentNames.length > 0 ? ` (${attendance.absentNames.join(', ')})` : ''
  const overrunTail = lunch.overrunNames.length > 0 ? ` (${lunch.overrunNames.map((l) => `${l.name} ${bn(l.min)} মি.`).join(', ')})` : ''
  const lines = [
    `📋 আজকের অফিস সারসংক্ষেপ — ${label}`,
    '',
    `👥 উপস্থিত: ${bn(attendance.present)}/${bn(attendance.roster)} জন`,
    attendance.late > 0 ? `⏰ দেরিতে এসেছেন: ${bn(attendance.late)} জন${lateTail}` : null,
    attendance.absent > 0 ? `🚫 অনুপস্থিত: ${bn(attendance.absent)} জন${absentTail}` : null,
    attendance.stillIn > 0 ? `🏢 এখনো চেক-আউট করেননি: ${bn(attendance.stillIn)} জন` : null,
    lunch.took > 0 ? `🍽️ লাঞ্চ নিয়েছেন: ${bn(lunch.took)} জন${lunch.overruns > 0 ? ` · বেশি সময়: ${bn(lunch.overruns)} জন${overrunTail}` : ''}` : null,
    '',
    `✅ সম্পন্ন: ${bn(done)}/${bn(total)} কাজ`,
    active > 0 ? `🔄 চলমান: ${bn(active)}টি` : null,
    pendingReview > 0 ? `⏳ আপনার অনুমোদনের অপেক্ষায়: ${bn(pendingReview)}টি` : null,
    `🤖 এজেন্ট নিজে সামলেছে: ${bn(accepted)}টি`,
    escalated > 0 ? `🔎 আপনাকে দেখাতে পাঠিয়েছে: ${bn(escalated)}টি` : `🔎 আপনাকে আলাদা করে কিছু পাঠাতে হয়নি`,
    awaitingUpdate > 0 ? `🔔 আপডেটের অপেক্ষায়: ${bn(awaitingUpdate)} জন` : null,
    proposals.length > 0 ? `🧾 আপনার সিদ্ধান্তের অপেক্ষায় প্রস্তাব: ${bn(proposals.length)}টি` : null,
    topPerformer ? `🌟 আজ এগিয়ে: ${topPerformer.name} (${bn(topPerformer.done)} কাজ)` : null,
  ].filter((l): l is string => l !== null)

  return {
    date: ymd,
    label,
    total,
    done,
    active,
    pendingReview,
    escalated,
    accepted,
    awaitingUpdate,
    proposals: proposals.length,
    topPerformer,
    attendance,
    lunch,
    text: lines.join('\n'),
    narrative: null,
  }
}

const NARRATIVE_SYSTEM_PROMPT = [
  'তুমি ALMA-র অফিস ম্যানেজার AI — দিনের শেষে মালিককে (যাকে "Boss" বলে সম্বোধন করবে) একটি মানবিক, উষ্ণ বাংলা রিপোর্ট লিখছ।',
  'একজন সত্যিকারের অফিস ম্যানেজার যেভাবে দিন শেষে বসের কাছে মুখে মুখে রিপোর্ট দেয়, সেভাবে লেখো — শুকনো পরিসংখ্যান নয়, একটা গল্পের মতো প্রবাহ।',
  'নিয়ম:',
  '- শুধু দেওয়া তথ্য ব্যবহার করবে। কোনো সংখ্যা বা নাম বানাবে না।',
  '- পুরোপুরি বাংলা, বাংলা সংখ্যা (১২৩) ব্যবহার করবে। ইসলামি শালীনতা বজায় রাখবে।',
  '- "Boss," দিয়ে শুরু করো। ৪–৭টি ছোট লাইন/বাক্য — হাজিরা, লাঞ্চ, কাজের অগ্রগতি, আর কোনটায় বসের নজর দরকার তা তুলে ধরো।',
  '- দেরি/অনুপস্থিতি/লাঞ্চ-ওভাররান থাকলে নরমভাবে, কিন্তু স্পষ্টভাবে জানাও (নাম সহ)। ভালো পারফরম্যান্স থাকলে প্রশংসা করো।',
  '- শেষে এক লাইনের ছোট, ইতিবাচক/দোয়ামূলক সমাপ্তি দাও।',
  '- ইমোজি সংযত ভাবে ব্যবহার করো (লাইনপ্রতি ১টির বেশি নয়)। মার্কডাউন হেডিং ব্যবহার করো না।',
].join('\n')

/** Compact, model-friendly fact sheet — only what the narrative may state. */
function digestFacts(d: OwnerDigest): string {
  const parts: string[] = []
  parts.push(`তারিখ: ${d.label}`)
  parts.push(`হাজিরা: উপস্থিত ${d.attendance.present}/${d.attendance.roster}, অনুপস্থিত ${d.attendance.absent}, দেরি ${d.attendance.late}, এখনো অফিসে ${d.attendance.stillIn}`)
  if (d.attendance.lateNames.length) parts.push(`দেরিতে এসেছেন: ${d.attendance.lateNames.map((l) => `${l.name} (${l.min} মিনিট)`).join(', ')}`)
  if (d.attendance.absentNames.length) parts.push(`অনুপস্থিত: ${d.attendance.absentNames.join(', ')}`)
  parts.push(`লাঞ্চ: ${d.lunch.took} জন নিয়েছেন, ${d.lunch.overruns} জন সময় বেশি নিয়েছেন`)
  if (d.lunch.overrunNames.length) parts.push(`লাঞ্চে বেশি সময়: ${d.lunch.overrunNames.map((l) => `${l.name} (${l.min} মিনিট)`).join(', ')}`)
  parts.push(`কাজ: মোট ${d.total}, সম্পন্ন ${d.done}, চলমান ${d.active}`)
  parts.push(`অনুমোদনের অপেক্ষায়: ${d.pendingReview}; এজেন্ট নিজে সামলেছে: ${d.accepted}; আপনাকে পাঠানো হয়েছে: ${d.escalated}`)
  parts.push(`আপডেটের অপেক্ষায় কাজ: ${d.awaitingUpdate}; সিদ্ধান্তের অপেক্ষায় প্রস্তাব: ${d.proposals}`)
  if (d.topPerformer) parts.push(`আজ সবচেয়ে এগিয়ে: ${d.topPerformer.name} (${d.topPerformer.done} কাজ)`)
  return parts.join('\n')
}

/**
 * Turn the structured digest into a warm, human "Boss, …" Bangla narrative via
 * Claude. Best-effort: returns null (caller falls back to the template) on any
 * failure or timeout, so the cron is never blocked by the model.
 */
export async function generateDigestNarrative(digest: OwnerDigest): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const userPrompt =
    `আজকের অফিসের তথ্য (এর বাইরে কিছু লিখবে না):\n${digestFacts(digest)}\n\n` +
    `এই তথ্য থেকে Boss-এর জন্য দিন-শেষের মানবিক বাংলা রিপোর্টটি লেখো:`

  let text = ''
  let inTok = 0
  let outTok = 0
  try {
    const client = new Anthropic({ apiKey })
    const res = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: DIGEST_MAX_TOKENS,
      system: NARRATIVE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })
    text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    inTok = res.usage?.input_tokens ?? 0
    outTok = res.usage?.output_tokens ?? 0
  } catch (err) {
    console.error('[office-digest] narrative LLM failed:', err)
    return null
  }

  if (!text) return null

  // Best-effort cost logging (Claude, once a day) — never block the report on it.
  if (inTok > 0 || outTok > 0) {
    try {
      const model = getModel(AGENT_MODEL)
      const costUsd = calcModelTurnCostUsd(model, { inputTokens: inTok, outputTokens: outTok })
      await logCost({
        provider: 'anthropic',
        kind: 'chat',
        units: { inputTokens: inTok, outputTokens: outTok, model: model.apiModel, role: 'office_daily_report' },
        costUsd,
        dedupKey: `office_digest:${digest.date}`,
      })
    } catch {
      /* cost logging is best-effort */
    }
  }
  return text
}

/**
 * Build and push the owner's daily digest to Telegram. Best-effort; returns the
 * digest so the caller (cron route) can report what it sent. Skips the push when
 * there was nothing at all to report (no tasks and nobody checked in). The pushed
 * message is the LLM "Boss, …" narrative, falling back to the structured template.
 */
export async function sendOwnerDigest(businessId = 'ALMA_LIFESTYLE', now: Date = new Date()): Promise<OwnerDigest & { pushed: boolean }> {
  const digest = await buildOwnerDigest(businessId, now)
  const hasActivity = digest.total > 0 || digest.attendance.present > 0 || digest.attendance.roster > 0
  if (!hasActivity) return { ...digest, pushed: false }

  const narrative = await generateDigestNarrative(digest)
  const body = narrative ?? digest.text
  await pushOwnerPing('🗒️ দিনের অফিস রিপোর্ট', body)
  return { ...digest, narrative, pushed: true }
}
