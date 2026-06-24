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
import { prisma } from '@/lib/prisma'
import { pushOwnerPing } from '@/agent/lib/office-notify'
import { listPendingProposals } from '@/agent/lib/office-proposals'
import { computeStaffPerformance } from '@/agent/lib/office-performance'

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
  /** The full Bangla message (what gets pushed to Telegram). */
  text: string
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

  const [todayTasks, updateRows, proposals, performance] = await Promise.all([
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
  ])

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
  const lines = [
    `📋 আজকের অফিস সারসংক্ষেপ — ${label}`,
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
    text: lines.join('\n'),
  }
}

/**
 * Build and push the owner's daily digest to Telegram. Best-effort; returns the
 * digest so the caller (cron route) can report what it sent. Skips the push when
 * there were no tasks at all (nothing worth pinging about).
 */
export async function sendOwnerDigest(businessId = 'ALMA_LIFESTYLE', now: Date = new Date()): Promise<OwnerDigest & { pushed: boolean }> {
  const digest = await buildOwnerDigest(businessId, now)
  let pushed = false
  if (digest.total > 0) {
    await pushOwnerPing('🗒️ দিনের অফিস রিপোর্ট', digest.text)
    pushed = true
  }
  return { ...digest, pushed }
}
