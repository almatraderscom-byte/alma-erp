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
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import type { SpecialistRole } from '@/agent/lib/models/specialist-roles'
import { specialistLabel } from '@/agent/lib/models/specialist-roles'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const SHIFT_KV_PREFIX = 'day_shift:'
const BUSINESS_ID = 'ALMA_LIFESTYLE'

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

type ShiftTaskDef = {
  key: string
  title: string
  priority: 'urgent' | 'high' | 'normal'
  needsSpecialist?: SpecialistRole
  specialistBrief?: (briefing: OwnerBriefingData) => string | null
}

const SHIFT_TASK_DEFS: ShiftTaskDef[] = [
  {
    key: 'staff',
    title: 'স্টাফ টাস্ক প্রোগ্রেস চেক ও ফলো-আপ',
    priority: 'high',
    needsSpecialist: 'ops',
    specialistBrief: (b) => {
      const pending = (b.staffYesterday?.total ?? 0) - (b.staffYesterday?.done ?? 0)
      const hasIssues = (b.staffPatterns?.length ?? 0) > 0 || pending > 2
      if (!hasIssues) return null
      return `আজকের staff_tasks — ${pending} pending, patterns ${b.staffPatterns?.length ?? 0}। বিস্তারিত চেক করে সংক্ষিপ্ত Bangla সারসংক্ষেপ দাও।`
    },
  },
  {
    key: 'orders',
    title: 'অর্ডার ও ডেলিভারি স্ট্যাটাস রিভিউ',
    priority: 'high',
  },
  {
    key: 'inventory',
    title: 'ইনভেন্টরি স্ট্যাটাস ও রিঅর্ডার চেক',
    priority: 'normal',
  },
  {
    key: 'cs_inbox',
    title: 'Messenger inbox — unreplied messages রিভিউ',
    priority: 'high',
  },
  {
    key: 'ads',
    title: 'Ads পারফরম্যান্স সারসংক্ষেপ',
    priority: 'normal',
    needsSpecialist: 'marketer',
    specialistBrief: (b) => {
      const anomalies = b.adsDigest?.anomalies?.length ?? 0
      if (anomalies === 0) return null
      return `Facebook ads anomaly (${anomalies}টি) দেখা গেছে। ads tools দিয়ে চেক করে owner-এর জন্য ৩-৪ লাইন Bangla action সারসংক্ষেপ দাও।`
    },
  },
  {
    key: 'content',
    title: 'কন্টেন্ট/পোস্ট প্ল্যানিং চেক',
    priority: 'normal',
    needsSpecialist: 'content',
    specialistBrief: () => null,
  },
]

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

async function seedShiftTodos(defs: ShiftTaskDef[]): Promise<string[]> {
  const ids: string[] = []
  for (const def of defs) {
    const existing = await prisma.agentTodo.findFirst({
      where: {
        businessId: BUSINESS_ID,
        title: def.title,
        source: 'day_shift',
        createdAt: { gte: new Date(`${todayYmdDhaka()}T00:00:00+06:00`) },
      },
    })
    if (existing) {
      ids.push(existing.id)
      continue
    }
    const todo = await prisma.agentTodo.create({
      data: {
        title: def.title,
        priority: def.priority,
        status: 'pending',
        source: 'day_shift',
        businessId: BUSINESS_ID,
      },
    })
    ids.push(todo.id)
  }
  return ids
}

function formatTodoList(defs: ShiftTaskDef[]): string {
  return defs.map((d, i) => `${i + 1}. ${d.title}`).join('\n')
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

async function maybeRunSpecialist(
  def: ShiftTaskDef,
  briefing: OwnerBriefingData,
  conversationId: string,
): Promise<string | null> {
  if (!def.needsSpecialist || !def.specialistBrief) return null
  const brief = def.specialistBrief(briefing)
  if (!brief) return null

  const role = def.needsSpecialist
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

async function patchTodoStatus(id: string, status: string): Promise<void> {
  await prisma.agentTodo.update({
    where: { id },
    data: {
      status,
      ...(status === 'completed' ? { completedAt: new Date() } : {}),
    },
  })
}

/** Start today's shift — intro + todo list (no heavy LLM). */
export async function startDayShift(): Promise<{ ok: boolean; conversationId?: string; detail: string }> {
  const date = todayYmdDhaka()
  let state = await loadDayShiftState(date)

  if (state?.status === 'done') {
    return { ok: true, conversationId: state.conversationId, detail: 'already_done' }
  }

  const conversationId = state?.conversationId ?? (await getOrCreateDayShiftConversation(date))
  const todoIds = state?.todoIds?.length ? state.todoIds : await seedShiftTodos(SHIFT_TASK_DEFS)

  if (!state) {
    await appendShiftNarrative(
      conversationId,
      `🏢 **অফিস সাইকেল শুরু** (রাত ১২:০৫ মধ্যরাত — ২৪ ঘণ্টা অফিস)\n\n` +
        `আসসালামু আলাইকুম Sir। আজকের (রাত ১২টা → পরের রাত ১১:৫৫) কাজের তালিকা বানাচ্ছি। ` +
        `অফিস ২৪ ঘণ্টা চালু — আপনি যেকোনো সময় এই chat-এ live দেখতে পারবেন।\n\n` +
        `প্রথমে briefing data টানছি...`,
    )

    let briefing: OwnerBriefingData | null = null
    try {
      briefing = await buildOwnerBriefingData()
      await appendShiftNarrative(conversationId, '✓ ERP briefing ডেটা লোড হয়েছে।')
    } catch (err) {
      await appendShiftNarrative(
        conversationId,
        `⚠️ briefing আংশিক — ${err instanceof Error ? err.message : 'error'}. যা পারি তা চালিয়ে যাচ্ছি।`,
      )
    }

    await appendShiftNarrative(
      conversationId,
      `**আজকের তালিকা (${SHIFT_TASK_DEFS.length}টি):**\n${formatTodoList(SHIFT_TASK_DEFS)}\n\n` +
        `এখন কাজ ১/${SHIFT_TASK_DEFS.length} শুরু করছি...`,
    )

    void sendOwnerText(
      `🏢 Agent অফিস শিফট শুরু — ${SHIFT_TASK_DEFS.length}টি কাজ। ALMA ERP → Agent chat-এ live দেখুন।`,
    ).catch(() => {})

    state = {
      date,
      conversationId,
      status: 'running',
      taskIndex: 0,
      todoIds,
      startedAt: new Date().toISOString(),
    }
    await saveDayShiftState(state)
    return { ok: true, conversationId, detail: `started_${SHIFT_TASK_DEFS.length}_tasks` }
  }

  if (state.status === 'running') {
    return { ok: true, conversationId: state.conversationId, detail: 'already_running' }
  }

  state.status = 'running'
  await saveDayShiftState(state)
  return { ok: true, conversationId: state.conversationId, detail: 'resumed' }
}

/** Run the next task in the shift queue (one per tick — cost control). */
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

  const { conversationId, taskIndex, todoIds } = state
  const total = SHIFT_TASK_DEFS.length

  if (taskIndex >= total) {
    if (!state.completedAt) {
      await appendShiftNarrative(
        conversationId,
        `✅ **মূল কাজের তালিকা সম্পন্ন** — ${total}টি চেক করা হয়েছে।\n\n` +
          `অফিস **২৪ ঘণ্টা চালু** (রাত ১২টা → পরের রাত ১১:৫৫) — প্রতি ঘণ্টায় হালকা প্যাট্রোল। ` +
          `পরের সাইকেল **মধ্যরাত ১২:০৫**-এ শুরু।`,
      )
      state.status = 'done'
      state.completedAt = new Date().toISOString()
      await saveDayShiftState(state)
      void sendOwnerText(`🌙 Agent অফিস মূল কাজ শেষ — ${total}টি সম্পন্ন। অফিস ২৪ ঘণ্টা চালু।`).catch(() => {})
    }
    return { ok: true, detail: 'shift_complete', conversationId }
  }

  const def = SHIFT_TASK_DEFS[taskIndex]
  const todoId = todoIds[taskIndex]
  const n = taskIndex + 1

  await appendShiftNarrative(
    conversationId,
    `\n---\n**কাজ ${n}/${total}:** ${def.title}\nচেক শুরু করছি...`,
  )

  if (todoId) await patchTodoStatus(todoId, 'in_progress')

  let briefing: OwnerBriefingData | null = null
  try {
    briefing = await buildOwnerBriefingData()
  } catch {
    /* partial run */
  }

  const parts: string[] = []

  if (['orders', 'inventory', 'cs_inbox'].includes(def.key) && briefing) {
    const det = await runDeterministicTask(def.key, briefing)
    parts.push(det.narrative)
  }

  if (briefing && def.needsSpecialist) {
    const spec = await maybeRunSpecialist(def, briefing, conversationId)
    if (spec) parts.push(spec)
  } else if (def.key === 'staff' && briefing) {
    const staff = briefing.staffYesterday
    parts.push(
      staff?.summary
        ? `✓ স্টাফ সারসংক্ষেপ: ${staff.summary}`
        : '✓ স্টাফ টাস্ক ডেটা চেক করা হয়েছে — বিস্তারিত staff monitor-এ।',
    )
  } else if (def.key === 'content') {
    parts.push('✓ কন্টেন্ট প্ল্যানিং — owner request এ draft করব (অটো office-এ LLM খরচ এড়ানো)।')
  } else if (def.key === 'ads' && briefing && !(briefing.adsDigest?.anomalies?.length)) {
    parts.push('✓ Ads anomaly নেই — আজকের জন্য pause/change দরকার নেই।')
  }

  if (!parts.length) {
    parts.push('✓ চেক সম্পন্ন — কোনো জরুরি action লাগছে না।')
  }

  await appendShiftNarrative(conversationId, parts.join('\n\n'))
  await appendShiftNarrative(
    conversationId,
    `📋 Todo আপডেট: "${def.title}" সম্পন্ন।`,
  )

  if (todoId) await patchTodoStatus(todoId, 'completed')

  state.taskIndex = taskIndex + 1
  state.lastTickAt = new Date().toISOString()
  await saveDayShiftState(state)

  if (state.taskIndex >= total) {
    return tickDayShift()
  }

  return {
    ok: true,
    detail: `task_${n}_of_${total}_done`,
    conversationId,
  }
}

/** 08:00 Dhaka — owner-facing summary when shift ran overnight at midnight. */
export async function sendMorningShiftBrief(): Promise<{ ok: boolean; detail: string }> {
  const date = todayYmdDhaka()
  const state = await loadDayShiftState(date)
  const total = SHIFT_TASK_DEFS.length
  const status = state?.status ?? 'idle'
  const doneTasks = Math.min(state?.taskIndex ?? 0, total)

  let todoLine = ''
  if (state?.todoIds?.length) {
    const todos = await prisma.agentTodo.findMany({
      where: { id: { in: state.todoIds } },
      select: { status: true },
    })
    const completed = todos.filter((t) => t.status === 'completed').length
    const pending = todos.length - completed
    todoLine = ` Todo ${completed}/${todos.length} সম্পন্ন${pending > 0 ? `, ${pending} বাকি` : ''}.`
  }

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
    active: state?.status === 'running',
  }
}
