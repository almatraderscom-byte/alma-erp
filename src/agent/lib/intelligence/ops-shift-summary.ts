/**
 * Ops-shift summary — partner-style staff/office read for the day-shift OPS duties.
 *
 * Point 1: the four OPS_DUTIES (morning_dispatch, staff_presence, midday_checkin,
 * outcome_measure) used to each fire the `ops` specialist on Claude Sonnet, producing
 * near-identical "0/16 কাজ শেষ" tables and burning ~$0.09–0.10 per duty. This module
 * replaces that with a single cheap DeepSeek pass that:
 *   - composes from a deterministic today-snapshot + yesterday briefing + memory history,
 *   - reads like an office manager / partner (varied, context-aware, not a robot table),
 *   - is de-duplicated by a state hash so an unchanged staff state reuses the cached text
 *     at zero cost (no repeated LLM call across the day's OPS ticks).
 *
 * Model is HARD-LOCKED to DeepSeek (`or-deepseek-v4-flash`) per owner instruction —
 * these office summaries must only run on DeepSeek. Critical ops routing (Claude-guarded)
 * is untouched; this path is text-only, no tools.
 */
import { prisma } from '@/lib/prisma'
import { getModel } from '@/agent/lib/models/registry'
import { runAdapterToolLoop } from '@/agent/lib/models/adapter-turn'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'
import { retrieveRelevantMemories } from '@/agent/lib/agent-memory'
import type { OwnerBriefingData } from '@/agent/lib/owner-briefing-data'

const OPS_SHIFT_MODEL_ID = 'or-deepseek-v4-flash'
const BUSINESS_ID = 'ALMA_LIFESTYLE'
const SUMMARY_KV_PREFIX = 'day_shift:ops_summary:'

export type OpsStaffSnapshot = {
  date: string
  total: number
  done: number
  dispatched: number
  proposedUnapproved: number
  pendingDispatch: boolean
  lowPerformers: number
}

function dateRangeYmd(ymd: string): { start: Date; end: Date } {
  const day = ymd.slice(0, 10)
  return {
    start: new Date(`${day}T00:00:00+06:00`),
    end: new Date(`${day}T23:59:59.999+06:00`),
  }
}

/** Deterministic today staff-task state — no LLM, drives both the prompt and the de-dup hash. */
export async function getTodayStaffSnapshot(
  date: string,
  briefing?: OwnerBriefingData | null,
): Promise<OpsStaffSnapshot> {
  const { start, end } = dateRangeYmd(date)
  const where = { proposedFor: { gte: start, lte: end } }

  const grouped = await prisma.agentStaffTask.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  })

  let total = 0
  let done = 0
  let dispatched = 0
  let proposedUnapproved = 0
  for (const g of grouped) {
    const n = g._count._all
    total += n
    const status = String(g.status)
    if (status === 'done' || status === 'completed') done += n
    if (['approved', 'sent', 'done', 'completed'].includes(status)) dispatched += n
    if (status === 'proposed') proposedUnapproved += n
  }

  const pendingRows = await prisma.agentPendingAction.findMany({
    where: { type: 'dispatch_staff_tasks', status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { payload: true },
  })
  const pendingDispatch = pendingRows.some((r) => {
    const payload =
      r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {}
    return String(payload.date ?? '').slice(0, 10) === date.slice(0, 10)
  })

  return {
    date: date.slice(0, 10),
    total,
    done,
    dispatched,
    proposedUnapproved,
    pendingDispatch,
    lowPerformers: briefing?.staffYesterday?.lowPerformers?.length ?? 0,
  }
}

/** Stable fingerprint of staff state — unchanged hash → reuse cached summary (no LLM cost). */
export function opsStateHash(s: OpsStaffSnapshot): string {
  return [
    s.total,
    s.done,
    s.dispatched,
    s.proposedUnapproved,
    s.pendingDispatch ? 1 : 0,
    s.lowPerformers,
  ].join('|')
}

type CachedOpsSummary = { hash: string; text: string }

function summaryKvKey(date: string): string {
  return `${SUMMARY_KV_PREFIX}${date.slice(0, 10)}`
}

function deterministicFallback(s: OpsStaffSnapshot, briefing?: OwnerBriefingData | null): string {
  const y = briefing?.staffYesterday
  const yLine = y ? ` গতকাল ${y.done}/${y.total} কাজ শেষ হয়েছিল।` : ''
  if (s.pendingDispatch || s.proposedUnapproved > 0) {
    return `Sir, আজকের স্টাফ টাস্ক এখনো আপনার approval-এর অপেক্ষায় — dispatch হলে কাজ শুরু হবে।${yLine}`
  }
  if (s.total === 0) {
    return `Sir, আজ এখনো কোনো স্টাফ টাস্ক dispatch হয়নি।${yLine} আপনি চাইলে আজকের কাজ ঠিক করে দিই।`
  }
  return `Sir, আজ ${s.done}/${s.total} স্টাফ কাজ শেষ${s.lowPerformers > 0 ? `, ${s.lowPerformers} জনের পারফরম্যান্স দুর্বল` : ''}।${yLine}`
}

async function recentOfficeMemoryLines(): Promise<string[]> {
  try {
    const mems = await retrieveRelevantMemories(
      'স্টাফ অফিস কাজ সাপ্তাহিক পারফরম্যান্স dispatch follow-up',
      false,
      BUSINESS_ID,
    )
    return mems.slice(0, 3).map((m) => `- ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`)
  } catch {
    return []
  }
}

function buildSystemPrompt(): string {
  return (
    'তুমি ALMA Lifestyle-এর একজন অভিজ্ঞ অফিস ম্যানেজার তথা পার্টনার, owner (Sir)-কে রিপোর্ট করছো। ' +
    'তোমার কাজ: আজকের স্টাফ/অফিস অবস্থা একজন মানুষ পার্টনারের মতো সংক্ষেপে বলা — robotic table নয়, ' +
    'প্রতিবার হুবহু একই বাক্য নয়। বাস্তব context (গতকালের কাজ, সাপ্তাহিক প্যাটার্ন) ব্যবহার করে ভিন্নভাবে বলো। ' +
    'যদি অবস্থা গতবারের মতোই থাকে, নতুন কিছু না বানিয়ে সংক্ষেপে অপরিবর্তিত বলে দাও। ' +
    'নিয়ম: ২–৪ লাইন বিশুদ্ধ বাংলা, Sir সম্বোধন, কোনো অপ্রয়োজনীয় ভূমিকা/markdown table নয়, কোনো সংখ্যা বানাবে না — শুধু দেওয়া ডেটা ব্যবহার করো।'
  )
}

function buildUserTask(
  s: OpsStaffSnapshot,
  briefing: OwnerBriefingData | null | undefined,
  memoryLines: string[],
  prevText: string | null,
): string {
  const y = briefing?.staffYesterday
  const patterns = (briefing?.staffPatterns ?? [])
    .slice(0, 3)
    .map((p) => `  • ${p.name}: ${p.detail}`)
    .join('\n')
  const lowNames = (y?.lowPerformers ?? [])
    .slice(0, 3)
    .map((l) => `${l.name} (${l.pct}%, ${l.daysLow} দিন)`)
    .join(', ')

  return [
    'আজকের স্টাফ-টাস্ক স্ন্যাপশট (deterministic, এগুলোই সত্য):',
    `- মোট টাস্ক: ${s.total}`,
    `- শেষ হয়েছে: ${s.done}`,
    `- dispatch হয়েছে: ${s.dispatched}`,
    `- approval-এর অপেক্ষায় (proposed): ${s.proposedUnapproved}`,
    `- pending dispatch owner approval: ${s.pendingDispatch ? 'হ্যাঁ' : 'না'}`,
    `- দুর্বল পারফরমার সংখ্যা: ${s.lowPerformers}`,
    '',
    'গতকালের অফিস:',
    y ? `- ${y.summary} (${y.done}/${y.total})` : '- ডেটা নেই',
    lowNames ? `- দুর্বল: ${lowNames}` : '',
    patterns ? `সাপ্তাহিক প্যাটার্ন:\n${patterns}` : '',
    memoryLines.length ? `মেমোরি থেকে সাম্প্রতিক context:\n${memoryLines.join('\n')}` : '',
    prevText
      ? `আগের বার তুমি বলেছিলে (হুবহু পুনরাবৃত্তি করো না, প্রয়োজনে অবস্থা একই থাকলে সংক্ষেপে confirm করো):\n"${prevText.slice(0, 240)}"`
      : '',
    '',
    'এখন owner-এর জন্য আজকের অফিস/স্টাফ অবস্থা একজন পার্টনারের মতো ২–৪ লাইনে বলো।',
  ]
    .filter((l) => l !== '')
    .join('\n')
}

async function composeOpsShiftSummary(args: {
  snapshot: OpsStaffSnapshot
  briefing: OwnerBriefingData | null | undefined
  prevText: string | null
  conversationId?: string
}): Promise<{ text: string; costUsd: number }> {
  const model = getModel(OPS_SHIFT_MODEL_ID)
  // Guard: if the registry id ever drifts off DeepSeek, fall back deterministically
  // rather than silently composing office summaries on a different (possibly pricier) model.
  if (model.id !== OPS_SHIFT_MODEL_ID) {
    return { text: deterministicFallback(args.snapshot, args.briefing), costUsd: 0 }
  }

  const memoryLines = await recentOfficeMemoryLines()
  const system = buildSystemPrompt()
  const userTask = buildUserTask(args.snapshot, args.briefing, memoryLines, args.prevText)

  try {
    const result = await runAdapterToolLoop({
      model,
      system,
      userTask,
      tools: [],
      maxIterations: 1,
      conversationId: args.conversationId,
      businessId: BUSINESS_ID,
    })

    const text = result.text.trim()
    if (!text) {
      return { text: deterministicFallback(args.snapshot, args.briefing), costUsd: 0 }
    }

    const costUsd = calcModelTurnCostUsd(model, {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheRead: result.cacheRead,
      cacheWrite: result.cacheWrite,
    })

    void logCost({
      provider: 'openai',
      kind: 'chat',
      units: {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        model: model.id,
        model_label: model.label,
        apiModel: model.apiModel,
        provider: model.provider,
        purpose: 'ops_shift_summary',
        via: 'openrouter',
      },
      costUsd,
      conversationId: args.conversationId ?? null,
      dedupKey: `ops_summary:${args.conversationId ?? 'na'}:${args.snapshot.date}:${opsStateHash(args.snapshot)}`,
    })

    return { text, costUsd }
  } catch {
    return { text: deterministicFallback(args.snapshot, args.briefing), costUsd: 0 }
  }
}

/**
 * De-duplicated ops summary for the day's OPS duties. Returns cached text at zero cost when
 * the staff state is unchanged since the last OPS tick; otherwise composes once on DeepSeek.
 */
export async function getOrComposeOpsSummary(
  date: string,
  conversationId: string,
  briefing: OwnerBriefingData | null,
): Promise<{ text: string; costUsd: number; cached: boolean }> {
  const snapshot = await getTodayStaffSnapshot(date, briefing)
  const hash = opsStateHash(snapshot)
  const key = summaryKvKey(date)

  let cached: CachedOpsSummary | null = null
  const row = await prisma.agentKvSetting.findUnique({ where: { key } })
  if (row?.value) {
    try {
      cached = JSON.parse(row.value) as CachedOpsSummary
    } catch {
      cached = null
    }
  }

  if (cached && cached.hash === hash && cached.text.trim()) {
    return { text: cached.text, costUsd: 0, cached: true }
  }

  const { text, costUsd } = await composeOpsShiftSummary({
    snapshot,
    briefing,
    prevText: cached?.text ?? null,
    conversationId,
  })

  const toStore: CachedOpsSummary = { hash, text }
  await prisma.agentKvSetting.upsert({
    where: { key },
    update: { value: JSON.stringify(toStore) },
    create: { key, value: JSON.stringify(toStore) },
  })

  return { text, costUsd, cached: false }
}
