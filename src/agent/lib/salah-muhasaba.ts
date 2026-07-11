/**
 * Nightly salah muhasaba (self-accountability + encouragement).
 *
 * Owner's intent: every night, gently reflect on the day's prayers — an honest
 * scorecard plus *encouragement* (uttaho), never blame. The harder pushing /
 * call escalation stays exactly as-is in the worker; this is the soft companion to it.
 *
 * Flow mirrors yesterday-accounting: send the muhasaba + set a "pending" KV marker;
 * the owner's first reply while pending is captured in core.ts and turned into a warm,
 * encouraging response via a contextBlock.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc } from '@/lib/agent-api/dhaka-date'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { summarizeWaqts, WAQTS } from '@/agent/lib/salah-context'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'

const BUSINESS_ID = 'ALMA_LIFESTYLE'

const WAQT_BN: Record<string, string> = {
  fajr: 'ফজর',
  dhuhr: 'যোহর',
  asr: 'আসর',
  maghrib: 'মাগরিব',
  isha: 'ইশা',
}

function pendingKey(ymd: string): string {
  return `salah_muhasaba_pending:${ymd}`
}

function resolvedKey(ymd: string): string {
  return `salah_muhasaba_resolved:${ymd}`
}

async function hasKv(key: string): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
  return Boolean(row?.value)
}

type DayTally = {
  onTime: number
  late: number
  qaza: number
  missed: number
  pending: number
}

async function tallyToday(now = new Date()): Promise<DayTally> {
  const today = todayYmdDhaka(now)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const records = await db.agentSalahRecord.findMany({
    where: { date: dhakaMidnightUtc(today) },
    orderBy: { windowStart: 'asc' },
  })
  const summary = summarizeWaqts(today, records, now)

  const tally: DayTally = { onTime: 0, late: 0, qaza: 0, missed: 0, pending: 0 }
  for (const s of summary) {
    if (s.status === 'prayed_on_time') tally.onTime++
    else if (s.status === 'prayed_late') tally.late++
    else if (s.status === 'qaza') tally.qaza++
    else if (s.isMissed || s.status === 'missed') tally.missed++
    else if (!s.notYetDue) tally.pending++
  }
  return tally
}

function encouragement(t: DayTally): string {
  if (t.onTime === WAQTS.length) {
    return 'মাশাআল্লাহ Boss — আজ পাঁচ ওয়াক্তই সময়মতো! 🤲 আল্লাহ এই অভ্যাস ধরে রাখার তাওফিক দিন। এটাই আপনার আসল সম্পদ।'
  }
  if (t.missed === 0 && t.qaza === 0) {
    return 'আলহামদুলিল্লাহ, আজ একটা ওয়াক্তও মিস হয়নি Boss। কাল ইনশাআল্লাহ দেরিগুলোও জামাতে ধরার চেষ্টা করি।'
  }
  if (t.missed > 0 || t.qaza > 0) {
    return (
      'Boss, যেগুলো মিস বা কাযা হয়েছে — সেটা স্বীকার করাটাই সততা, আর আল্লাহ সততা ভালোবাসেন। ' +
      'একটু তাওবা করে নিন, অপরাধবোধে ডুবে থাকবেন না। কাল নতুন সুযোগ — ইনশাআল্লাহ আমরা একসাথে ধরবো। 💚'
    )
  }
  return 'Boss, আজকের চেষ্টাটুকু আল্লাহ দেখেছেন। কাল আরেকটু যত্ন নিলেই হবে ইনশাআল্লাহ। 🤲'
}

function composeMuhasaba(t: DayTally): string {
  const lines = [
    `🌙 *Boss, দিনের শেষে একটু মুহাসাবা করি* — আজকের নামাজের হিসাব:`,
    ``,
    `✅ সময়মতো: ${t.onTime}`,
    `🕐 দেরিতে: ${t.late}`,
    `🕋 কাযা: ${t.qaza}`,
    `❌ মিস: ${t.missed}`,
  ]
  if (t.pending > 0) lines.push(`⏳ এখনো বাকি: ${t.pending}`)
  lines.push(``, encouragement(t), ``)
  lines.push(
    `নিজের কাছে সৎ থেকে একটু ভাবুন Boss — কোন ওয়াক্তটা আরেকটু যত্ন চাইত? ` +
    `দু-এক লাইনে বললে আমি মনে রাখবো, কাল সেটা জামাতে ধরতে সাহায্য করবো। 🤲`,
  )
  return lines.join('\n')
}

/** Called nightly. Sends the muhasaba + sets a pending marker (idempotent per day). */
export async function runMuhasabaSend(now = new Date()): Promise<{
  ok: boolean
  asked: boolean
  detail: string
}> {
  const today = todayYmdDhaka(now)
  if (await hasKv(resolvedKey(today))) return { ok: true, asked: false, detail: 'already_resolved' }
  if (await hasKv(pendingKey(today))) return { ok: true, asked: false, detail: 'already_pending' }

  const tally = await tallyToday(now)
  const message = composeMuhasaba(tally)
  void sendOwnerText(message).catch(() => {})

  await prisma.agentKvSetting.upsert({
    where: { key: pendingKey(today) },
    create: {
      key: pendingKey(today),
      value: JSON.stringify({ date: today, tally, sentAt: now.toISOString() }),
    },
    update: { value: JSON.stringify({ date: today, tally, sentAt: now.toISOString() }) },
  })

  return { ok: true, asked: true, detail: `muhasaba_sent_${today}` }
}

async function markResolved(ymd: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: resolvedKey(ymd) },
    create: { key: resolvedKey(ymd), value: 'resolved' },
    update: { value: 'resolved' },
  })
  await prisma.agentKvSetting.deleteMany({ where: { key: pendingKey(ymd) } })
}

export async function isMuhasabaPending(now = new Date()): Promise<boolean> {
  const today = todayYmdDhaka(now)
  if (await hasKv(resolvedKey(today))) return false
  return hasKv(pendingKey(today))
}

function looksLikeReflection(text: string): boolean {
  const t = text.trim()
  if (t.length < 2) return false
  if (/^(ok|okay|hmm|hm|na|ha|haan|thik|tnx|thanks)$/i.test(t)) return false
  return true
}

export type MuhasabaReplyResult = { contextBlock?: string }

/**
 * Capture the owner's nightly reflection (first reply while muhasaba is pending).
 * Saves it to memory and returns a contextBlock so the head replies with warm
 * encouragement (uttaho) — never blame.
 */
export async function processMuhasabaReply(
  text: string,
  _conversationId?: string,
  now = new Date(),
): Promise<MuhasabaReplyResult | null> {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!(await isMuhasabaPending(now))) return null
  if (!looksLikeReflection(trimmed)) return null

  const today = todayYmdDhaka(now)
  const reflection = trimmed.slice(0, 500)

  try {
    await createOrUpdateAgentMemory({
      scope: 'business',
      key: `salah_muhasaba:${today}`,
      content: `রাতের সালাহ মুহাসাবা (${today}) — Boss-এর নিজের প্রতিফলন: ${reflection}`,
      metadata: { type: 'salah_muhasaba', date: today, businessId: BUSINESS_ID },
      importance: 2,
    })
  } catch (err) {
    console.warn('[muhasaba] memory save failed:', err instanceof Error ? err.message : err)
  }

  await markResolved(today)

  return {
    contextBlock:
      `[SALAH MUHASABA — ACTIVE]\n` +
      `It is night reflection time. Boss just shared his own muhasaba (self-reflection) about today's prayers; ` +
      `it is ALREADY saved to memory — do NOT call save_memory for it. ` +
      `Respond in warm Bangla as Boss: (1) acknowledge his honesty/effort with genuine encouragement (uttaho) and NO blame, ` +
      `(2) give ONE small, practical du'a or tip to help tomorrow's prayers go better (e.g. an early reminder, wudu ready, jamaat intention), ` +
      `(3) end with a short hopeful du'a. Keep it 3-4 lines, gentle and uplifting.`,
  }
}
