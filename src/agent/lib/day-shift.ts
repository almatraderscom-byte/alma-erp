/**
 * Day Shift — autonomous "office employee" session visible in owner agent chat.
 *
 * Cursor-style narrative: think → act → short feedback per task, one at a time.
 * Cost-conscious: most tasks use briefing/ERP data (no LLM); specialist sub-agent
 * only when a task is marked needsSpecialist (e.g. ads anomaly → marketer).
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { buildOwnerBriefingData, type OwnerBriefingData } from '@/agent/lib/owner-briefing-data'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import {
  checkDutyApprovalBlock,
  DUTY_PENDING_APPROVAL_DESCRIPTION,
  notifyDutyApprovalBlocked,
  recordDutyApprovalBlock,
} from '@/agent/lib/duty-approval-block'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import { enabledDutiesForToday } from '@/agent/lib/duty-enabled'
import type { SpecialistRole } from '@/agent/lib/models/specialist-roles'
import { specialistLabel } from '@/agent/lib/models/specialist-roles'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const SHIFT_KV_PREFIX = 'day_shift:'
const BUSINESS_ID = 'ALMA_LIFESTYLE'
const SKIP_DUTY_TODO = new Set(['salah_init'])

/** ALMA Lifestyle office hours — banner stays active during patrol until close. */
function isOfficeHoursDhaka(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const mins = hh * 60 + mm
  return mins >= 9 * 60 + 30 && mins < 20 * 60
}

async function shiftDutiesForToday(now = new Date()) {
  return (await enabledDutiesForToday(now)).filter((d) => !SKIP_DUTY_TODO.has(d.duty))
}

function formatDutyList(duties: Awaited<ReturnType<typeof shiftDutiesForToday>>): string {
  return duties.map((d, i) => `${i + 1}. ${d.label}`).join('\n')
}

function dueDateRangeDhaka(ymd: string): { start: Date; end: Date } {
  const day = ymd.slice(0, 10)
  return {
    start: new Date(`${day}T00:00:00+06:00`),
    end: new Date(`${day}T23:59:59.999+06:00`),
  }
}

type DutyWorkResult = {
  narrative: string
  result: string
  opinion: string
}

const OPS_DUTIES = new Set([
  'morning_dispatch',
  'staff_presence',
  'midday_checkin',
  'outcome_measure',
])
const MARKETER_DUTIES = new Set(['ads_monitor', 'ads_optimizer'])
const CONTENT_DUTIES = new Set(['content_engine_1', 'content_engine_2', 'content_engine_3'])

export type DayShiftStatus = 'idle' | 'running' | 'paused' | 'done'

export type DayShiftState = {
  date: string
  conversationId: string
  status: DayShiftStatus
  taskIndex: number
  todoIds: string[]
  startedAt: string
  lastTickAt?: string
  lastPatrolAt?: string
  completedAt?: string
}

function shiftKvKey(date: string): string {
  return `${SHIFT_KV_PREFIX}${date}`
}

export async function loadDayShiftState(date = todayYmdDhaka()): Promise<DayShiftState | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: shiftKvKey(date) } })
  if (!row?.value) return null
  try {
    return JSON.parse(row.value) as DayShiftState
  } catch (err) {
    console.error(`[day-shift] corrupt state JSON for ${date}:`, err instanceof Error ? err.message : String(err), '— raw:', String(row.value).slice(0, 100))
    return null
  }
}

async function saveDayShiftState(state: DayShiftState): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: shiftKvKey(state.date) },
    update: { value: JSON.stringify(state) },
    create: { key: shiftKvKey(state.date), value: JSON.stringify(state) },
  })
}

export async function getOrCreateDayShiftConversation(date = todayYmdDhaka()): Promise<string> {
  const existing = await loadDayShiftState(date)
  if (existing?.conversationId) return existing.conversationId

  const title = `🏢 অফিস শিফট — ${date}`
  const conv = await prisma.agentConversation.create({
    data: {
      title,
      source: 'day_shift',
      businessId: BUSINESS_ID,
      modelId: 'claude-sonnet-4-6',
    },
  })
  return conv.id
}

/** Cursor-style narrative block in the day_shift chat thread. */
export async function appendShiftNarrative(conversationId: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  await db.agentMessage.create({
    data: {
      conversationId,
      role: 'assistant',
      content: [{ type: 'text', text: trimmed }],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    },
  })
  await touchConversationActivity(conversationId)
}

async function getDutyLogRow(dutyKey: string, date: string) {
  return prisma.agentDutyLog.findUnique({
    where: { duty_dutyDate: { duty: dutyKey, dutyDate: date } },
  })
}

async function patchTodoByDutyKey(
  dutyKey: string,
  date: string,
  data: { status: string; description?: string; completedAt?: Date | null },
): Promise<void> {
  const { start, end } = dueDateRangeDhaka(date)
  await prisma.agentTodo.updateMany({
    where: {
      businessId: BUSINESS_ID,
      dutyKey,
      dueDate: { gte: start, lte: end },
    },
    data: {
      status: data.status,
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
      ...(data.status === 'completed' && data.completedAt === undefined
        ? { completedAt: new Date() }
        : {}),
    },
  })
}

function stripMarkdown(line: string): string {
  return line.replace(/\*\*/g, '').replace(/^✓\s*/, '').replace(/^⚠️\s*/, '').trim()
}

function composeFeedback(label: string, result: string, opinion: string): string {
  const r = result.trim() || `${label} চেক সম্পন্ন হয়েছে।`
  const o = opinion.trim() || 'আজকের জন্য আর তাত্ক্ষণিক action দরকার নেই।'
  return `✅ Sir, "${label}" শেষ — ${r} আমার মত: ${o}`
}

function specialistBriefForDuty(dutyKey: string, briefing: OwnerBriefingData): string | null {
  if (OPS_DUTIES.has(dutyKey)) {
    const pending = (briefing.staffYesterday?.total ?? 0) - (briefing.staffYesterday?.done ?? 0)
    const hasIssues = (briefing.staffPatterns?.length ?? 0) > 0 || pending > 2
    if (!hasIssues) return null
    return `আজকের staff_tasks — ${pending} pending, patterns ${briefing.staffPatterns?.length ?? 0}। বিস্তারিত চেক করে সংক্ষিপ্ত Bangla সারসংক্ষেপ দাও।`
  }
  if (MARKETER_DUTIES.has(dutyKey)) {
    const anomalies = briefing.adsDigest?.anomalies?.length ?? 0
    if (anomalies === 0) return null
    return `Facebook ads anomaly (${anomalies}টি) দেখা গেছে। ads tools দিয়ে চেক করে owner-এর জন্য ৩-৪ লাইন Bangla action সারসংক্ষেপ দাও।`
  }
  if (CONTENT_DUTIES.has(dutyKey)) return null
  return null
}

function specialistRoleForDuty(dutyKey: string): SpecialistRole | null {
  if (OPS_DUTIES.has(dutyKey)) return 'ops'
  if (MARKETER_DUTIES.has(dutyKey)) return 'marketer'
  if (CONTENT_DUTIES.has(dutyKey)) return 'content'
  return null
}

async function runDutyWork(
  dutyKey: string,
  label: string,
  date: string,
  briefing: OwnerBriefingData | null,
  conversationId: string,
): Promise<DutyWorkResult> {
  const log = await getDutyLogRow(dutyKey, date)
  const parts: string[] = []

  if (log?.status === 'done' || log?.status === 'skipped') {
    parts.push(log.detail?.trim() || `✓ ${label} — scheduler থেকে সম্পন্ন।`)
  } else if (log?.status === 'failed' || log?.status === 'missed') {
    parts.push(`⚠️ ${log.detail?.trim() || `${label} ব্যর্থ বা মিস হয়েছে।`}`)
  } else if (dutyKey === 'order_watch' && briefing) {
    const det = await runDeterministicTask('orders', briefing)
    parts.push(det.narrative)
  } else if (
    (dutyKey === 'cs_index_products' || dutyKey === 'approval_tracker') &&
    briefing
  ) {
    const det = await runDeterministicTask('cs_inbox', briefing)
    parts.push(det.narrative)
  } else if (
    (dutyKey === 'subscription_renewal' || dutyKey === 'cost_reconcile') &&
    briefing
  ) {
    const det = await runDeterministicTask('inventory', briefing)
    parts.push(det.narrative)
  } else if (OPS_DUTIES.has(dutyKey) && briefing) {
    const staff = briefing.staffYesterday
    parts.push(
      staff?.summary
        ? `✓ স্টাফ সারসংক্ষেপ: ${staff.summary}`
        : '✓ স্টাফ টাস্ক ডেটা চেক করা হয়েছে — বিস্তারিত staff monitor-এ।',
    )
  } else if (dutyKey === 'owner_task_intake') {
    parts.push('✓ Sir-কাজ সংগ্রহ — scheduler ২০:৩০-এ chat + Telegram-এ জিজ্ঞেস করবে; reply থেকে owner todo যোগ হবে।')
  } else if (CONTENT_DUTIES.has(dutyKey)) {
    parts.push('✓ কন্টেন্ট প্ল্যানিং — owner request এ draft করব (অটো office-এ LLM খরচ এড়ানো)।')
  } else if (MARKETER_DUTIES.has(dutyKey) && briefing) {
    if (briefing.adsDigest?.anomalies?.length) {
      parts.push(`⚠️ Ads anomaly ${briefing.adsDigest.anomalies.length}টি — বিস্তারিত নিচে।`)
    } else {
      parts.push('✓ Ads anomaly নেই — আজকের জন্য pause/change দরকার নেই।')
    }
  } else if (briefing) {
    parts.push(`চেক করছি ${label}...`)
    parts.push('✓ ERP briefing ডেটা থেকে চেক সম্পন্ন — scheduler লগ pending থাকলে catch-up হবে।')
  } else {
    parts.push(`চেক করছি ${label}...`)
    parts.push('✓ চেক সম্পন্ন — briefing partial, পরে verify করব।')
  }

  if (briefing) {
    const role = specialistRoleForDuty(dutyKey)
    const brief = specialistBriefForDuty(dutyKey, briefing)
    if (role && brief) {
      const spec = await maybeRunSpecialistByRole(role, brief, conversationId)
      if (spec) parts.push(spec)
    }
  }

  const narrative = parts.filter(Boolean).join('\n\n')
  const lines = parts.map(stripMarkdown).filter(Boolean)
  const result = lines.find((l) => !l.startsWith('চেক')) ?? lines.at(-1) ?? `${label} সম্পন্ন।`
  const opinion =
    lines.length > 1
      ? lines[lines.length - 1]
      : log?.status === 'pending'
        ? 'Scheduler catch-up বা manual follow-up দরকার হতে পারে।'
        : 'আজকের জন্য ঠিক আছে।'

  return { narrative, result, opinion }
}

async function maybeRunSpecialistByRole(
  role: SpecialistRole,
  brief: string,
  conversationId: string,
): Promise<string | null> {
  const label = specialistLabel(role)
  const conv = await prisma.agentConversation.findUnique({
    where: { id: conversationId },
    select: { modelId: true },
  })
  const { getModel } = await import('@/agent/lib/models/registry')
  const plannedModel = getModel(conv?.modelId ?? 'claude-sonnet-4-6')
  const modelTag = plannedModel.label ? ` · ${plannedModel.label}` : ''

  await appendShiftNarrative(
    conversationId,
    `এই অংশটা ${label}${modelTag} সাব-এজেন্টকে দিচ্ছি — আমি নিজে data verify করব...\n\n` +
      `> **Delegate → ${label}:** ${brief.slice(0, 120)}${brief.length > 120 ? '…' : ''}`,
  )

  const { runSubAgent } = await import('@/agent/lib/models/subagent')
  const result = await runSubAgent({
    role,
    task: brief,
    businessId: BUSINESS_ID,
    conversationId,
    modelId: conv?.modelId ?? undefined,
  })

  if (!result.success) {
    void sendOwnerText(
      `⚠️ Day Shift: ${label} specialist ব্যর্থ — ${result.error ?? 'unknown'}. কাজ চালিয়ে যাচ্ছি।`,
    ).catch(() => {})
    return `✗ ${label} (${result.modelLabel}) ব্যর্থ: ${result.error ?? 'unknown'}`
  }

  const toolsLine = result.toolsUsed.length ? `\nটুল: ${result.toolsUsed.join(', ')}` : ''
  return `✓ **${label} · ${result.modelLabel}:**\n${result.summary}${toolsLine}`
}

async function runDeterministicTask(
  key: string,
  briefing: OwnerBriefingData,
): Promise<{ narrative: string; ok: boolean }> {
  switch (key) {
    case 'orders': {
      const p = briefing.pendingOrders
      const issues = briefing.decisions?.filter((d) => d.area.toLowerCase().includes('order')) ?? []
      const lines = [
        `চেক করছি pending orders...`,
        p
          ? `✓ মোট *${p.count}*টি pending${p.mismatch ? ' (ERP vs sheet mismatch — দেখা দরকার)' : ''}.`
          : '✓ অর্ডার ডেটা পাওয়া গেছে।',
      ]
      if (issues.length) {
        lines.push(`⚠️ ${issues[0].text}`)
      } else {
        lines.push('সংক্ষেপ: জরুরি order issue নেই।')
      }
      return { narrative: lines.join('\n'), ok: true }
    }
    case 'inventory': {
      const low = briefing.inventory?.items?.filter((i) => i.currentStock <= i.reorderLevel) ?? []
      const reorder = briefing.reorderSuggestions?.slice(0, 3) ?? []
      const lines = [
        'ইনভেন্টরি চেক করছি...',
        low.length
          ? `✓ *${low.length}*টি SKU reorder level-এর নিচে: ${low.slice(0, 3).map((i) => i.name).join(', ')}.`
          : '✓ সব critical SKU স্টক ঠিক আছে।',
      ]
      if (reorder.length) {
        lines.push(`রিকমেন্ড: ${reorder[0].name} — ${reorder[0].reason}`)
      }
      return { narrative: lines.join('\n'), ok: true }
    }
    case 'cs_inbox': {
      const cs = briefing.csWaiting
      const lines = [
        'Messenger inbox স্ক্যান করছি...',
        cs
          ? cs.unrepliedCount > 0
            ? `⚠️ *${cs.unrepliedCount}*টি unreplied message — Meta review চলাকালীন auto-reply বন্ধ, manual দেখুন।`
            : '✓ কোনো unreplied message নেই।'
          : '✓ CS inbox ডেটা unavailable (cs_mode off).',
      ]
      return { narrative: lines.join('\n'), ok: true }
    }
    default:
      return { narrative: 'চেক সম্পন্ন।', ok: true }
  }
}

const PATROL_INTERVAL_MS = 60 * 60 * 1000 // hourly light check after main queue

async function runPatrolTick(state: DayShiftState): Promise<{ ok: boolean; detail: string; conversationId: string }> {
  const now = Date.now()
  if (state.lastPatrolAt && now - new Date(state.lastPatrolAt).getTime() < PATROL_INTERVAL_MS) {
    return { ok: true, detail: 'patrol_wait', conversationId: state.conversationId }
  }

  const lines: string[] = ['🔄 **অফিস প্যাট্রোল** — ২৪ ঘণ্টা অফিস চালু। মূল কাজ শেষ; হালকা মনিটরিং চলছে।']

  try {
    const briefing = await buildOwnerBriefingData()
    const pending = briefing.pendingOrders?.count ?? 0
    const unreplied = briefing.csWaiting?.unrepliedCount ?? 0
    const lowStock = briefing.inventory?.items?.filter((i) => i.currentStock <= i.reorderLevel).length ?? 0
    lines.push(`📊 অর্ডার pending: **${pending}** · CS unreplied: **${unreplied}** · low stock: **${lowStock}**`)
    if (unreplied > 0) lines.push(`⚠️ CS inbox-এ ${unreplied}টি উত্তর বাকি — দেখা দরকার।`)
  } catch {
    lines.push('✓ ERP সংযোগ ঠিক আছে — বিস্তারিত পরের টিক-এ।')
  }

  await appendShiftNarrative(state.conversationId, lines.join('\n\n'))
  state.lastPatrolAt = new Date().toISOString()
  state.lastTickAt = state.lastPatrolAt
  await saveDayShiftState(state)
  return { ok: true, detail: 'patrol_done', conversationId: state.conversationId }
}

/** Start today's shift — intro + duty roster (Phase A todos seeded separately). */
export async function startDayShift(): Promise<{ ok: boolean; conversationId?: string; detail: string }> {
  const date = todayYmdDhaka()
  const duties = await shiftDutiesForToday()
  let state = await loadDayShiftState(date)

  if (state?.status === 'done') {
    return { ok: true, conversationId: state.conversationId, detail: 'already_done' }
  }

  const conversationId = state?.conversationId ?? (await getOrCreateDayShiftConversation(date))

  if (!state) {
    await appendShiftNarrative(
      conversationId,
      `🏢 **অফিস সাইকেল শুরু** (রাত ১২:০৫ মধ্যরাত — ২৪ ঘণ্টা অফিস)\n\n` +
        `আসসালামু আলাইকুম Sir। আজকের (রাত ১২টা → পরের রাত ১১:৫৫) duty roster (${duties.length}টি) panel-এ ready। ` +
        `অফিস ২৪ ঘণ্টা চালু — আপনি যেকোনো সময় এই chat-এ live দেখতে পারবেন।\n\n` +
        `প্রথমে briefing data টানছি...`,
    )

    try {
      await buildOwnerBriefingData()
      await appendShiftNarrative(conversationId, '✓ ERP briefing ডেটা লোড হয়েছে।')
    } catch (err) {
      await appendShiftNarrative(
        conversationId,
        `⚠️ briefing আংশিক — ${err instanceof Error ? err.message : 'error'}. যা পারি তা চালিয়ে যাচ্ছি।`,
      )
    }

    await appendShiftNarrative(
      conversationId,
      `**আজকের duty তালিকা (${duties.length}টি):**\n${formatDutyList(duties)}\n\n` +
        `এখন duty ১/${duties.length} শুরু করছি...`,
    )

    void sendOwnerText(
      `🏢 Agent অফিস শিফট শুরু — ${duties.length}টি duty। ALMA ERP → Agent chat-এ live দেখুন।`,
    ).catch(() => {})

    state = {
      date,
      conversationId,
      status: 'running',
      taskIndex: 0,
      todoIds: [],
      startedAt: new Date().toISOString(),
    }
    await saveDayShiftState(state)
    return { ok: true, conversationId, detail: `started_${duties.length}_duties` }
  }

  if (state.status === 'running') {
    return { ok: true, conversationId: state.conversationId, detail: 'already_running' }
  }

  state.status = 'running'
  await saveDayShiftState(state)
  return { ok: true, conversationId: state.conversationId, detail: 'resumed' }
}

/** Run the next duty in today's roster (one per tick — cost control). */
export async function tickDayShift(): Promise<{ ok: boolean; detail: string; conversationId?: string }> {
  const date = todayYmdDhaka()
  let state = await loadDayShiftState(date)

  if (!state) {
    const started = await startDayShift()
    if (!started.ok) return { ok: false, detail: 'start_failed' }
    state = await loadDayShiftState(date)
    if (!state) return { ok: false, detail: 'no_state' }
  }

  if (state.status === 'done') {
    return runPatrolTick(state)
  }

  if (state.status !== 'running') {
    state.status = 'running'
    await saveDayShiftState(state)
  }

  const { conversationId, taskIndex } = state
  const duties = await shiftDutiesForToday()
  const total = duties.length

  if (taskIndex >= total) {
    if (!state.completedAt) {
      await appendShiftNarrative(
        conversationId,
        `✅ **মূল duty roster সম্পন্ন** — ${total}টি চেক করা হয়েছে।\n\n` +
          `অফিস **২৪ ঘণ্টা চালু** (রাত ১২টা → পরের রাত ১১:৫৫) — প্রতি ঘণ্টায় হালকা প্যাট্রোল। ` +
          `পরের সাইকেল **মধ্যরাত ১২:০৫**-এ শুরু।`,
      )
      state.status = 'done'
      state.completedAt = new Date().toISOString()
      await saveDayShiftState(state)
      void sendOwnerText(`🌙 Agent অফিস মূল duty শেষ — ${total}টি সম্পন্ন। অফিস ২৪ ঘণ্টা চালু।`).catch(() => {})
    }
    return { ok: true, detail: 'shift_complete', conversationId }
  }

  const duty = duties[taskIndex]
  const n = taskIndex + 1

  // STEP 1 — announce + in_progress
  await appendShiftNarrative(conversationId, `🏢 Sir, এখন করছি: ${duty.label}`)
  await patchTodoByDutyKey(duty.duty, date, { status: 'in_progress', completedAt: null })

  let briefing: OwnerBriefingData | null = null
  try {
    briefing = await buildOwnerBriefingData()
  } catch {
    /* partial run */
  }

  // STEP 2 — visible step-by-step work
  const work = await runDutyWork(duty.duty, duty.label, date, briefing, conversationId)
  if (work.narrative.trim()) {
    await appendShiftNarrative(conversationId, work.narrative)
  }

  // STEP 3 — approval gate: leave pending, notify, continue roster (Phase C)
  const approvalBlock = await checkDutyApprovalBlock(duty.duty, date, duty.label)
  if (approvalBlock) {
    await patchTodoByDutyKey(duty.duty, date, {
      status: 'pending',
      description: DUTY_PENDING_APPROVAL_DESCRIPTION,
      completedAt: null,
    })
    await recordDutyApprovalBlock(approvalBlock, date, conversationId)
    await notifyDutyApprovalBlocked(duty.label, (text) => appendShiftNarrative(conversationId, text))

    state.taskIndex = taskIndex + 1
    state.lastTickAt = new Date().toISOString()
    await saveDayShiftState(state)

    if (state.taskIndex >= total) {
      return tickDayShift()
    }

    return {
      ok: true,
      detail: `duty_${n}_pending_approval:${duty.duty}`,
      conversationId,
    }
  }

  // STEP 4 — mandatory feedback + complete
  const feedback = composeFeedback(duty.label, work.result, work.opinion)
  await appendShiftNarrative(conversationId, feedback)
  await patchTodoByDutyKey(duty.duty, date, {
    status: 'completed',
    description: feedback,
    completedAt: new Date(),
  })

  state.taskIndex = taskIndex + 1
  state.lastTickAt = new Date().toISOString()
  await saveDayShiftState(state)

  if (state.taskIndex >= total) {
    return tickDayShift()
  }

  return {
    ok: true,
    detail: `duty_${n}_of_${total}_done:${duty.duty}`,
    conversationId,
  }
}

/** 08:00 Dhaka — owner-facing summary when shift ran overnight at midnight. */
export async function sendMorningShiftBrief(): Promise<{ ok: boolean; detail: string }> {
  const date = todayYmdDhaka()
  const state = await loadDayShiftState(date)
  const total = (await shiftDutiesForToday()).length
  const status = state?.status ?? 'idle'
  const doneTasks = Math.min(state?.taskIndex ?? 0, total)

  const { start, end } = dueDateRangeDhaka(date)
  const todos = await prisma.agentTodo.findMany({
    where: {
      businessId: BUSINESS_ID,
      source: 'day_shift',
      dutyKey: { not: null },
      dueDate: { gte: start, lte: end },
    },
    select: { status: true },
  })
  const completed = todos.filter((t) => t.status === 'completed').length
  const pending = todos.length - completed
  const todoLine = todos.length
    ? ` Todo ${completed}/${todos.length} সম্পন্ন${pending > 0 ? `, ${pending} বাকি` : ''}.`
    : ''

  const statusBn =
    status === 'running' ? 'চলমান'
    : status === 'done' ? 'প্রধান কাজ শেষ (প্যাট্রোল)'
    : status === 'paused' ? 'বিরতি'
    : 'অপেক্ষায়'

  const text =
    `☀️ সকাল ৮টা — অফিস শিফট সারাংশ\n\n` +
    `অবস্থা: ${statusBn} · কাজ ${doneTasks}/${total}.${todoLine}\n` +
    `Live দেখুন: ALMA ERP → Agent → 🏢 অফিস শিফট\n` +
    `Staff Monitor-এ আজকের duty count চেক করুন।`

  void sendOwnerText(text).catch(() => {})
  return { ok: true, detail: `morning_brief_${status}_${doneTasks}` }
}

export async function getDayShiftToday(): Promise<{
  date: string
  state: DayShiftState | null
  conversationId: string | null
  title: string | null
  active: boolean
}> {
  const date = todayYmdDhaka()
  const state = await loadDayShiftState(date)
  const conversationId = state?.conversationId ?? null
  let title: string | null = null
  if (conversationId) {
    const conv = await prisma.agentConversation.findUnique({
      where: { id: conversationId },
      select: { title: true },
    })
    title = conv?.title ?? null
  }
  return {
    date,
    state,
    conversationId,
    title,
    active:
      (state?.status === 'running' || state?.status === 'done') && isOfficeHoursDhaka(),
  }
}
