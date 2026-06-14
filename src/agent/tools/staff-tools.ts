/**
 * Phase 6A — Staff manager agent tools.
 * These run in the agent's tool-call loop (Vercel, not worker).
 * The agent proposes/approves tasks; the worker handles dispatch timing.
 */
import { prisma } from '@/lib/prisma'
import { buildStaffTaskProposal, _resetProfileCache } from '@/agent/lib/staff-task-proposal'
import {
  syncPendingDispatchAction,
  refreshAndApproveDispatch,
  prepareCorrectedDispatchPending,
  loadProposedTasksForDate,
  buildDispatchSummary,
} from '@/agent/lib/staff-dispatch-sync'
import { enforceIslamicGreeting } from '@/agent/lib/islamic-greeting'
import { prepareStaffOutboundMessage } from '@/agent/lib/alma-team-voice'
import {
  announcementContradictsRecentDispatch,
  buildCorrectionNoticeMessage,
  getStaffDispatchCorrectionContext,
} from '@/agent/lib/dispatch-correction-notice'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// ── Helpers ──────────────────────────────────────────────────────────────────

function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) // YYYY-MM-DD
}

function dhakaDateStr(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

async function resolveActiveProposalDate(explicit?: string): Promise<string> {
  if (explicit) return explicit
  const pending = await db.agentPendingAction.findFirst({
    where: { type: 'dispatch_staff_tasks', status: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  })
  const payloadDate = (pending?.payload as { date?: string } | null)?.date
  return payloadDate || dhakaToday()
}

async function findStaffByName(staffName: string) {
  const trimmed = staffName.trim()
  if (!trimmed) return null
  const exact = await db.agentStaff.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' }, active: true },
    select: { id: true, name: true },
  })
  if (exact) return exact
  return db.agentStaff.findFirst({
    where: { name: { contains: trimmed, mode: 'insensitive' }, active: true },
    select: { id: true, name: true },
  })
}

function buildStaffMessageDraftSummary(
  staff: Array<{ name: string }>,
  message: string,
  sendVoice: boolean,
  label = 'স্টাফ মেসেজ',
): string {
  const names = staff.map((s) => s.name).join(', ')
  const voiceLine = sendVoice ? 'হ্যাঁ (শুধু স্টাফ)' : 'না'
  const preview = message.length > 1200 ? `${message.slice(0, 1200)}…` : message
  return (
    `📢 ${label} — অনুমোদন প্রয়োজন\n\n` +
    `প্রাপক: ${names}\n` +
    `ভয়েস নোট: ${voiceLine}\n\n` +
    `--- ড্রাফ্ট ---\n${preview}\n---`
  )
}

async function createStaffAnnouncementPending(opts: {
  staff: Array<{ id: string; name: string; telegramChatId: string | null }>
  message: string
  sendVoice: boolean
  conversationId?: string
  label?: string
}) {
  const prepared = prepareStaffOutboundMessage(opts.message)
  const summary = buildStaffMessageDraftSummary(
    opts.staff,
    prepared,
    opts.sendVoice,
    opts.label,
  )
  const action = await db.agentPendingAction.create({
    data: {
      conversationId: opts.conversationId ? String(opts.conversationId) : null,
      type: 'staff_announcement',
      payload: {
        message: prepared,
        staffChatIds: opts.staff.map((s) => ({
          id: s.id,
          name: s.name,
          chatId: s.telegramChatId,
        })),
        sendVoice: opts.sendVoice,
      },
      summary,
      costEstimate: 0,
      status: 'pending',
    },
  })
  return { pendingActionId: action.id as string, summary, preparedMessage: prepared }
}

// ── prepare_staff_task_proposal ───────────────────────────────────────────────

const prepare_staff_task_proposal: AgentTool = {
  name: 'prepare_staff_task_proposal',
  description:
    'MUST use when owner asks about staff tasks for today. ' +
    'Checks inventory, 30-day sales, FB posts, yesterday carry-forward — builds full Bangla task plan for all staff. ' +
    'Saves as proposed tasks and optionally creates approval card. ' +
    'Do NOT ask owner "কি বিষয়ে টাস্ক দিব" — run this tool first.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
      saveProposal: { type: 'boolean', description: 'Save tasks as proposed (default true)' },
      createApprovalCard: { type: 'boolean', description: 'Create dispatch confirm card (default true)' },
      conversationId: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const save = input.saveProposal !== false
      const createCard = input.createApprovalCard !== false

      const proposal = await buildStaffTaskProposal(date)
      if (!proposal.success) return { success: false, error: proposal.error }

      if (!proposal.tasks.length) {
        return { success: false, error: 'ডেটা থেকে কোনো টাস্ক জেনারেট হয়নি — ERP/অর্ডার চেক করুন' }
      }

      if (save) {
        await db.agentStaffTask.deleteMany({
          where: { proposedFor: new Date(date), status: 'proposed' },
        })
        await db.agentStaffTask.createMany({
          data: proposal.tasks.map((t) => ({
            staffId: t.staffId,
            title: t.title,
            detail: t.detail ?? null,
            type: t.type,
            productRef: t.productRef ?? null,
            source: t.source,
            status: 'proposed',
            proposedFor: new Date(date),
          })),
        })
      }

      let pendingActionId: string | undefined
      if (createCard && save) {
        await db.agentPendingAction.updateMany({
          where: { type: 'dispatch_staff_tasks', status: 'pending' },
          data: { status: 'superseded', resolvedAt: new Date() },
        })
        pendingActionId = (await syncPendingDispatchAction(date)) ?? undefined
      }

      return {
        success: true,
        data: {
          date,
          taskCount: proposal.tasks.length,
          tasks: proposal.tasks,
          rotationPicks: proposal.rotationPicks,
          topProducts: proposal.topProducts,
          carryForwardCount: proposal.carryForwardCount,
          pendingOrders: proposal.pendingOrders,
          summaryBangla: proposal.summaryBangla,
          pendingActionId,
          message:
            'প্রস্তাব তৈরি হয়েছে। মালিককে summaryBangla দেখান এবং Approve করতে বলুন — তারপর স্টাফকে Telegram-এ যাবে।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_staff_tasks ───────────────────────────────────────────────────────────

const get_staff_tasks: AgentTool = {
  name: 'get_staff_tasks',
  description:
    'Returns the task list for a given date (default: today). ' +
    'Includes proposed, approved, sent, done, carried, and cancelled tasks per staff member.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date:     { type: 'string', description: 'YYYY-MM-DD (default: today in Asia/Dhaka)' },
      staffId:  { type: 'string', description: 'Filter by specific staff ID (optional)' },
      statusFilter: { type: 'string', description: 'Comma-separated statuses to include (optional)' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const where: Record<string, unknown> = { proposedFor: new Date(date) }
      if (input.staffId) where.staffId = String(input.staffId)
      if (input.statusFilter) where.status = { in: String(input.statusFilter).split(',').map(s => s.trim()) }

      const tasks = await db.agentStaffTask.findMany({
        where,
        include: { staff: { select: { id: true, name: true, role: true, telegramChatId: true } } },
        orderBy: [{ staffId: 'asc' }, { createdAt: 'asc' }],
      })

      const staffTasks: Record<string, { staff: unknown; tasks: unknown[] }> = {}
      for (const t of tasks) {
        const key = t.staff.id
        if (!staffTasks[key]) staffTasks[key] = { staff: t.staff, tasks: [] }
        staffTasks[key].tasks.push({
          id: t.id, title: t.title, type: t.type, status: t.status,
          detail: t.detail, productRef: t.productRef, source: t.source,
          completedAt: t.completedAt,
        })
      }

      return { success: true, data: { date, staffGroups: Object.values(staffTasks) } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_all_staff ─────────────────────────────────────────────────────────────

const get_all_staff: AgentTool = {
  name: 'get_all_staff',
  description: 'Returns all active staff members with their IDs and Telegram link status.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const staff = await db.agentStaff.findMany({
        where: { active: true },
        select: { id: true, name: true, role: true, telegramChatId: true },
        orderBy: { name: 'asc' },
      })
      return { success: true, data: staff }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── propose_staff_tasks ───────────────────────────────────────────────────────

const propose_staff_tasks: AgentTool = {
  name: 'propose_staff_tasks',
  description:
    'Saves a batch of proposed tasks for a given date (status=proposed). ' +
    'Called by the agent during morning planning before the owner approval card. ' +
    'Clears any existing proposed tasks for that date first to avoid duplicates.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today in Asia/Dhaka)' },
      tasks: {
        type: 'array',
        description: 'Array of task objects',
        items: {
          type: 'object',
          properties: {
            staffId:    { type: 'string' },
            title:      { type: 'string' },
            detail:     { type: 'string' },
            type:       { type: 'string', enum: ['ad_creative','product_content','product_photo','video_reel','listing_update','order_followup','page_management','customer_reply','content_support','office_task','stock_check','misc'] },
            productRef: { type: 'string' },
            source:     { type: 'string', enum: ['rotation','pattern','owner','agent'] },
          },
          required: ['staffId', 'title', 'type'],
        },
      },
    },
    required: ['tasks'],
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const tasks = input.tasks as Array<{
        staffId: string; title: string; detail?: string;
        type: string; productRef?: string; source?: string;
      }>
      if (!tasks?.length) return { success: false, error: 'tasks array is empty' }

      // Clear existing proposed tasks for this date (only proposed — don't touch approved/sent)
      await db.agentStaffTask.deleteMany({
        where: { proposedFor: new Date(date), status: 'proposed' },
      })

      const created = await db.agentStaffTask.createMany({
        data: tasks.map(t => ({
          staffId:    t.staffId,
          title:      t.title,
          detail:     t.detail ?? null,
          type:       t.type || 'misc',
          productRef: t.productRef ?? null,
          source:     t.source || 'agent',
          status:     'proposed',
          proposedFor: new Date(date),
        })),
      })

      const pendingActionId = await syncPendingDispatchAction(date)

      return {
        success: true,
        data: {
          date,
          tasksCreated: created.count,
          pendingActionId: pendingActionId ?? undefined,
          message: pendingActionId
            ? 'Tasks saved and pending dispatch card synced from DB.'
            : 'Tasks saved (no pending card — call approve_and_dispatch_tasks if needed).',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── merge_into_proposal ───────────────────────────────────────────────────────

const merge_into_proposal: AgentTool = {
  name: 'merge_into_proposal',
  description:
    'Add/edit/remove tasks in the ACTIVE unapproved proposal — never discard existing tasks. ' +
    'MUST persist via this tool (not text-only lists). Re-show full updated list for approval. ' +
    'Before approve: get_current_proposal to verify DB matches what owner saw. Use add_staff_task_now only when NO active proposal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD of the active proposal (default: pending proposal date)' },
      staffName: { type: 'string', description: 'Which staff member the task is for' },
      additions: {
        type: 'array',
        description: 'New tasks to append',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' },
            type: { type: 'string', description: 'e.g. learning, research, video_reel, misc, custom' },
          },
          required: ['title'],
        },
      },
      edits: {
        type: 'array',
        description: 'Edits to existing proposed tasks',
        items: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            newTitle: { type: 'string' },
            newDetail: { type: 'string' },
          },
          required: ['taskId'],
        },
      },
      removeTaskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs to remove from the proposal',
      },
    },
    required: ['staffName'],
  },
  handler: async (input) => {
    try {
      const date = await resolveActiveProposalDate(input.date as string | undefined)
      const staffName = String(input.staffName)
      const staff = await findStaffByName(staffName)
      if (!staff) return { success: false, error: `Staff "${staffName}" not found.` }

      const additions = (input.additions ?? []) as Array<{ title: string; detail?: string; type?: string }>
      const edits = (input.edits ?? []) as Array<{ taskId: string; newTitle?: string; newDetail?: string }>
      const removeTaskIds = (input.removeTaskIds ?? []) as string[]

      if (!additions.length && !edits.length && !removeTaskIds.length) {
        return { success: false, error: 'No additions, edits, or removals specified.' }
      }

      if (additions.length) {
        await db.agentStaffTask.createMany({
          data: additions.map((t) => ({
            staffId: staff.id,
            title: t.title,
            detail: t.detail ?? null,
            type: t.type ?? 'misc',
            status: 'proposed',
            proposedFor: new Date(date),
            source: 'owner_manual',
          })),
        })
      }

      for (const e of edits) {
        const patch: Record<string, string> = {}
        if (e.newTitle) patch.title = e.newTitle
        if (e.newDetail) patch.detail = e.newDetail
        if (Object.keys(patch).length) {
          await db.agentStaffTask.updateMany({
            where: {
              id: e.taskId,
              staffId: staff.id,
              status: 'proposed',
              proposedFor: new Date(date),
            },
            data: patch,
          })
        }
      }

      if (removeTaskIds.length) {
        await db.agentStaffTask.deleteMany({
          where: {
            id: { in: removeTaskIds },
            staffId: staff.id,
            status: 'proposed',
            proposedFor: new Date(date),
          },
        })
      }

      const staffTasks = await db.agentStaffTask.findMany({
        where: { staffId: staff.id, status: 'proposed', proposedFor: new Date(date) },
        select: { id: true, title: true, detail: true, type: true },
        orderBy: { createdAt: 'asc' },
      })

      const allProposed = await db.agentStaffTask.findMany({
        where: { proposedFor: new Date(date), status: 'proposed' },
        include: { staff: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      })

      const summaryBangla = allProposed
        .map((t: { staff: { name: string }; title: string }) => `• ${t.staff.name}: ${t.title}`)
        .join('\n')

      const pendingActionId = await syncPendingDispatchAction(date)

      return {
        success: true,
        data: {
          status: 'merged',
          date,
          staffName: staff.name,
          staffTasks,
          allTasks: allProposed.map((t: { id: string; staff: { name: string }; title: string; detail: string | null; type: string }) => ({
            id: t.id,
            staffName: t.staff.name,
            title: t.title,
            detail: t.detail,
            type: t.type,
          })),
          taskCount: allProposed.length,
          summaryBangla,
          pendingActionId,
          message: `Proposal updated for ${staff.name}. Show all ${allProposed.length} tasks for approval — do NOT discard other staff tasks.`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── approve_pending_dispatch ──────────────────────────────────────────────────

const approve_pending_dispatch: AgentTool = {
  name: 'approve_pending_dispatch',
  description:
    'Approve the CURRENTLY pending staff-task dispatch so the worker actually sends it. ' +
    'Use when the owner says "approve", "পাঠাও", "approve korlam", "হ্যাঁ পাঠাও" AND a dispatch_staff_tasks ' +
    'pending action already exists. This flips it to approved so the worker dispatches. ' +
    'Do NOT create a new proposal/card when one is already pending — approve the existing one.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: from pending action or today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || undefined
      const pending = await db.agentPendingAction.findFirst({
        where: { type: 'dispatch_staff_tasks', status: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: { payload: true },
      })
      const payload = pending?.payload as { date?: string } | undefined
      const actionDate = date || payload?.date || dhakaToday()

      if (payload?.date && date && payload.date !== date) {
        return {
          success: false,
          error: `Pending dispatch is for ${payload.date}, not ${date}. Approve that date or omit date.`,
        }
      }

      const result = await refreshAndApproveDispatch(actionDate)
      if (!result.ok) {
        return {
          success: true,
          data: {
            status: 'none_pending',
            message: 'কোনো proposed টাস্ক নেই। আগে merge_into_proposal বা propose_staff_tasks চালান।',
          },
        }
      }

      return {
        success: true,
        data: {
          status: 'approved_queued',
          approvedActionId: result.pendingActionId,
          date: result.date,
          taskCount: result.taskCount,
          taskIds: result.taskIds,
          message:
            `Approve করা হয়েছে (${result.taskCount}টি টাস্ক DB থেকে sync করে) — worker dispatch করবে। ` +
            'নিশ্চিত হওয়ার আগে "পাঠানো হয়েছে" বলবেন না; get_dispatch_status দিয়ে verify করুন।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_dispatch_status ───────────────────────────────────────────────────────

const get_dispatch_status: AgentTool = {
  name: 'get_dispatch_status',
  description:
    'Check the REAL dispatch/delivery status of staff tasks for a date: how many tasks are proposed/approved/sent, ' +
    'and (if outbox exists) how many messages were delivered/failed per staff. Use BEFORE telling the owner ' +
    'whether tasks were sent. Never claim delivery without calling this.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const proposedFor = new Date(date)

      const statusRows = await db.agentStaffTask.groupBy({
        by: ['status'],
        where: { proposedFor },
        _count: { _all: true },
      })

      const taskCounts: Record<string, number> = {}
      for (const row of statusRows as Array<{ status: string; _count: { _all: number } }>) {
        taskCounts[row.status] = row._count._all
      }

      let deliveryByStaff: Record<string, { delivered: number; failed: number }> | null = null
      try {
        const dayStart = new Date(`${date}T00:00:00+06:00`)
        const rows = await db.agentOutbox.findMany({
          where: { type: 'task_dispatch', createdAt: { gte: dayStart } },
          select: { staffName: true, status: true },
        })
        const byStaff: Record<string, { delivered: number; failed: number }> = {}
        for (const r of rows as Array<{ staffName: string | null; status: string }>) {
          const name = r.staffName ?? '—'
          byStaff[name] ??= { delivered: 0, failed: 0 }
          if (r.status === 'delivered') byStaff[name].delivered++
          if (r.status === 'failed') byStaff[name].failed++
        }
        deliveryByStaff = byStaff
      } catch {
        deliveryByStaff = null
      }

      const pendingAction = await db.agentPendingAction.findFirst({
        where: { type: 'dispatch_staff_tasks' },
        orderBy: { createdAt: 'desc' },
        select: { status: true, createdAt: true },
      })

      const correctionContext = await getStaffDispatchCorrectionContext(date)

      return {
        success: true,
        data: {
          date,
          taskCounts,
          pendingActionStatus: pendingAction?.status ?? 'none',
          pendingActionCreatedAt: pendingAction?.createdAt ?? null,
          deliveryByStaff,
          correctionContext,
          correctionNoticeRule:
            'After wrong-task correction: call send_dispatch_correction_notice (reads outbox). ' +
            'Never say "নতুন লিস্ট শীঘ্রই আসবে" if correctionContext shows new_already_sent.',
          note: deliveryByStaff === null
            ? 'Outbox not available — rely on task sent-count; Staff Monitor (Prompt D) for delivery proof.'
            : 'deliveryByStaff is the source of truth for actual delivery.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_lunch_status ──────────────────────────────────────────────────────────

const get_lunch_status: AgentTool = {
  name: 'get_lunch_status',
  description:
    'Who is on lunch today (45min allowance) and completed records. Flag repeated overruns in staff reports — occasional overrun kindly. ' +
    'Use when owner asks "ke lunch e ache?" or lunch patterns.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const now = Date.now()

      const rows = await db.staffLunch.findMany({
        where: { lunchDate: date },
        orderBy: { startedAt: 'desc' },
        select: {
          staffId: true,
          staffName: true,
          startedAt: true,
          endedAt: true,
          durationMin: true,
          overage: true,
        },
      })

      const onLunch = rows
        .filter((r: { endedAt: Date | null }) => !r.endedAt)
        .map((r: { staffName: string | null; startedAt: Date }) => {
          const mins = Math.round((now - new Date(r.startedAt).getTime()) / 60000)
          return {
            name: r.staffName ?? '—',
            minutes: mins,
            overAllowance: mins > 45,
            critical: mins >= 60,
          }
        })

      const completed = rows
        .filter((r: { endedAt: Date | null }) => r.endedAt)
        .map((r: { staffName: string | null; durationMin: number | null; overage: boolean }) => ({
          name: r.staffName ?? '—',
          durationMin: r.durationMin,
          overage: r.overage,
        }))

      return {
        success: true,
        data: {
          date,
          currentlyOnLunch: onLunch,
          completedToday: completed,
          summaryBangla:
            onLunch.length === 0
              ? `আজ (${date}) কেউ লাঞ্চে নেই।`
              : onLunch
                  .map(
                    (s: { name: string; minutes: number; overAllowance: boolean }) =>
                      `${s.name}: ${s.minutes} মিনিট${s.overAllowance ? ' (৪৫+)' : ''}`,
                  )
                  .join('; '),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_current_proposal ──────────────────────────────────────────────────────

const get_current_proposal: AgentTool = {
  name: 'get_current_proposal',
  description:
    'Returns the ACTUAL proposed tasks saved in DB for a date — this is what will be dispatched on approve. ' +
    'Call after merge_into_proposal and BEFORE approve_pending_dispatch to verify the list matches what you showed the owner.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const proposed = await loadProposedTasksForDate(date)
      const byStaff: Record<string, Array<{ id: string; title: string; type: string }>> = {}
      for (const t of proposed) {
        const name = t.staff.name
        byStaff[name] ??= []
        byStaff[name].push({ id: t.id, title: t.title, type: t.type })
      }
      return {
        success: true,
        data: {
          date,
          totalTasks: proposed.length,
          byStaff,
          summaryBangla: buildDispatchSummary(date, proposed),
          note: 'This DB snapshot is dispatched on approve — never show the owner a list you have not saved via merge_into_proposal / propose_staff_tasks.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── correct_and_redispatch_staff_tasks ────────────────────────────────────────

const correct_and_redispatch_staff_tasks: AgentTool = {
  name: 'correct_and_redispatch_staff_tasks',
  description:
    'Wrong tasks were already sent. Cancels sent/approved tasks for the date and creates a PENDING dispatch approval card ' +
    'from the CURRENT proposed list in DB — does NOT send to staff until the owner explicitly approves. ' +
    'Use when owner says "ভুল টাস্ক গেছে", "আগেরটা বাদ দিয়ে ঠিকটা পাঠাও". ' +
    'Correct proposed tasks MUST already be in DB (merge_into_proposal / propose_staff_tasks) before calling. ' +
    'After calling, show the full list and wait for approve_pending_dispatch — never auto-dispatch.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const proposed = await loadProposedTasksForDate(date)
      if (!proposed.length) {
        return {
          success: false,
          error: 'DB-তে proposed টাস্ক নেই। আগে merge_into_proposal দিয়ে সঠিক তালিকা সেভ করুন।',
        }
      }

      const result = await prepareCorrectedDispatchPending(date)
      if (!result.ok) {
        return { success: false, error: 'Redispatch prep failed — no proposed tasks after cancel.' }
      }

      return {
        success: true,
        data: {
          status: 'correction_pending_approval',
          date,
          pendingActionId: result.pendingActionId,
          cancelledWrongTasks: result.cancelledCount,
          proposedTaskCount: result.proposedCount,
          taskIds: result.taskIds,
          summaryBangla: result.summaryBangla,
          message:
            `${result.cancelledCount}টি ভুল টাস্ক cancelled। ${result.proposedCount}টি সঠিক টাস্ক approval card-এ তৈরি — ` +
            'এখনো পাঠানো হয়নি। মালিক Approve/পাঠাও বললে approve_pending_dispatch চালান। ' +
            '"পাঠানো হয়েছে" বলবেন না — get_dispatch_status দিয়ে verify করুন।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── approve_and_dispatch_tasks ────────────────────────────────────────────────

const approve_and_dispatch_tasks: AgentTool = {
  name: 'approve_and_dispatch_tasks',
  description:
    'Creates a NEW pending approval card for proposed tasks. ' +
    'If a dispatch_staff_tasks card is ALREADY pending, do NOT use this — use approve_pending_dispatch instead. ' +
    'Use after propose_staff_tasks when no pending dispatch card exists yet.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date:           { type: 'string', description: 'YYYY-MM-DD (default: today)' },
      conversationId: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const proposed = await db.agentStaffTask.findMany({
        where: { proposedFor: new Date(date), status: 'proposed' },
        include: { staff: { select: { name: true } } },
      })
      if (!proposed.length) return { success: false, error: `No proposed tasks found for ${date}` }

      const existingPending = await db.agentPendingAction.findFirst({
        where: { type: 'dispatch_staff_tasks', status: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (existingPending) {
        return {
          success: false,
          error:
            'A pending dispatch card already exists. Use approve_pending_dispatch when the owner approves in chat — do NOT create another card.',
          pendingActionId: existingPending.id as string,
        }
      }

      // Resolve any stale pending dispatch actions
      await db.agentPendingAction.updateMany({
        where: { type: 'dispatch_staff_tasks', status: 'pending' },
        data: { status: 'superseded', resolvedAt: new Date() },
      })

      const summary = proposed
        .map((t: { staff: { name: string }; title: string; type: string }) =>
          `• ${t.staff.name}: ${t.title} (${t.type})`)
        .join('\n')

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type:     'dispatch_staff_tasks',
          payload:  { date, taskIds: proposed.map((t: { id: string }) => t.id) },
          summary:  `স্টাফ টাস্ক ডিসপ্যাচ — ${date}\n\n${summary}`,
          costEstimate: 0,
          status:   'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary:  action.summary,
          taskCount: proposed.length,
          status: 'queued_for_dispatch',
          message:
            'Tasks queued. Delivery to each staff is confirmed by the worker — do NOT tell the owner "sent" until the worker confirmation arrives. If asked, say tasks are queued and confirmation is pending.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── add_staff_task_now ─────────────────────────────────────────────────────────

const add_staff_task_now: AgentTool = {
  name: 'add_staff_task_now',
  description:
    'Adds a single task to today\'s list for a staff member mid-day when there is NO active unapproved proposal. ' +
    'If a pending staff proposal exists, use merge_into_proposal instead. ' +
    'Creates a PENDING ACTION — owner must approve before the task is saved and the staff member is notified.',
  input_schema: {
    type: 'object' as const,
    properties: {
      staffId:        { type: 'string', description: 'Staff member ID' },
      title:          { type: 'string', description: 'Task title (Bangla preferred)' },
      type:           { type: 'string', enum: ['ad_creative','product_content','stock_check','listing_update','order_followup','misc'] },
      detail:         { type: 'string', description: 'Optional task detail' },
      conversationId: { type: 'string' },
    },
    required: ['staffId', 'title', 'type'],
  },
  handler: async (input) => {
    try {
      const staffId = String(input.staffId)
      const staff = await db.agentStaff.findUnique({ where: { id: staffId }, select: { name: true } })
      if (!staff) return { success: false, error: `Staff ${staffId} not found` }

      const summary = `${staff.name}-কে নতুন টাস্ক যোগ: "${input.title}" (${input.type})`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type:     'add_staff_task_now',
          payload:  {
            staffId, staffName: staff.name,
            title: String(input.title),
            type:  String(input.type),
            detail: input.detail ? String(input.detail) : null,
            date:  dhakaToday(),
          },
          summary,
          costEstimate: 0,
          status:  'pending',
        },
      })

      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, message: 'Pending owner approval.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── send_dispatch_correction_notice ───────────────────────────────────────────

const send_dispatch_correction_notice: AgentTool = {
  name: 'send_dispatch_correction_notice',
  description:
    'After wrong-task correction: prepare correction notice DRAFT for staff (pending Approve). ' +
    'Reads agent_outbox — if a new task_dispatch was ALREADY delivered (even 1 min ago), ' +
    'tells staff to follow THAT list (never "coming soon"). ' +
    'Call AFTER approve_pending_dispatch + get_dispatch_status confirms delivery. ' +
    'Does NOT send until owner approves via approve_pending_staff_message. ' +
    'Do NOT use send_staff_announcement for this — this tool verifies outbox first.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
      staffIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit to specific staff (optional — default: staff with task_dispatch today)',
      },
      sendVoice: { type: 'boolean', description: 'TTS voice note (default: true)' },
    },
  },
  handler: async (input) => {
    try {
      const date = (input.date as string) || dhakaToday()
      const staffIds = input.staffIds as string[] | undefined
      const sendVoice = input.sendVoice !== false

      const ctx = await getStaffDispatchCorrectionContext(date, staffIds)
      if (!ctx.length) {
        return {
          success: false,
          error: 'আজ কোনো task_dispatch outbox নেই — আগে approve_pending_dispatch + get_dispatch_status দিয়ে verify করুন।',
        }
      }

      const staffRows = await db.agentStaff.findMany({
        where: {
          active: true,
          telegramChatId: { not: null },
          id: {
            in: ctx.map((c) => c.staffId).filter((id): id is string => Boolean(id)),
          },
        },
        select: { id: true, name: true, telegramChatId: true },
      })

      const staffById = new Map(staffRows.map((s: { id: string }) => [s.id, s]))
      const messageGroups = new Map<string, typeof staffRows>()

      for (const c of ctx) {
        if (!c.staffId) continue
        const row = staffById.get(c.staffId)
        if (!row) continue
        const message = enforceIslamicGreeting(buildCorrectionNoticeMessage(c.staffName, c.situation))
        const bucket = messageGroups.get(message) ?? []
        bucket.push(row)
        messageGroups.set(message, bucket)
      }

      if (!messageGroups.size) {
        return { success: false, error: 'No Telegram-linked staff found for correction notice.' }
      }

      const sent: Array<{ messagePreview: string; staff: string[]; situation: string; pendingActionId: string }> = []
      for (const [message, group] of messageGroups) {
        const { pendingActionId, summary } = await createStaffAnnouncementPending({
          staff: group,
          message,
          sendVoice,
          conversationId: input.conversationId as string | undefined,
          label: 'ডিসপ্যাচ সংশোধন নোটিশ',
        })
        const sample = ctx.find((c) => c.staffId === group[0]?.id)
        sent.push({
          messagePreview: message.slice(0, 80),
          staff: group.map((s: { name: string }) => s.name),
          situation: sample?.situation ?? 'unknown',
          pendingActionId,
        })
      }

      return {
        success: true,
        data: {
          status: 'pending_approval',
          pendingActionId: sent[0]?.pendingActionId,
          pendingActionIds: sent.map((s) => s.pendingActionId),
          date,
          drafts: sent,
          correctionContext: ctx,
          message:
            `${sent.length}টি correction notice draft তৈরি — এখনো পাঠানো হয়নি। ` +
            'মালিক প্রতিটি Approve করলে পাঠানো হবে (approve_pending_staff_message বা Approve বাটন)।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── send_staff_announcement ───────────────────────────────────────────────────

const send_staff_announcement: AgentTool = {
  name: 'send_staff_announcement',
  description:
    'Prepare a staff announcement/news/notice DRAFT (text + optional voice to STAFF only). ' +
    'Creates a PENDING confirm card — does NOT send until owner approves. ' +
    'NOT a task — no Done buttons, no completion tracking. ' +
    'Use for: rule changes, policy updates, office notices, reminders, personal messages to staff. ' +
    'Write from ALMA team voice ("আমরা/ALMA টিম"), never as owner proxy. ' +
    'After draft, wait for Approve — never say "পাঠানো হয়েছে" before approval + outbox proof. ' +
    'Do NOT use for wrong-task correction notices — use send_dispatch_correction_notice instead. ' +
    'Do NOT use this for work assignments — use propose_staff_tasks or add_staff_task_now for those.',
  input_schema: {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        description: 'The announcement message in Bangla. Will be sent as text AND voice note.',
      },
      staffIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific staff IDs to send to (optional — if empty, sends to ALL active staff with Telegram linked)',
      },
      sendVoice: {
        type: 'boolean',
        description: 'Also send as voice note via TTS (default: true)',
      },
    },
    required: ['message'],
  },
  handler: async (input) => {
    try {
      const message = String(input.message ?? '').trim()
      if (!message) return { success: false, error: 'message is required' }

      const sendVoice = input.sendVoice !== false
      const staffIds = input.staffIds as string[] | undefined
      const date = dhakaToday()

      const contradiction = await announcementContradictsRecentDispatch(message, date, staffIds)
      if (contradiction.blocked) {
        return { success: false, error: contradiction.reason }
      }

      const where: Record<string, unknown> = {
        active: true,
        telegramChatId: { not: null },
      }
      if (staffIds?.length) {
        where.id = { in: staffIds }
      }

      const staff = await db.agentStaff.findMany({
        where,
        select: { id: true, name: true, telegramChatId: true },
      })

      if (!staff.length) {
        return { success: true, data: { status: 'no_staff', message: 'No active staff with Telegram linked found.' } }
      }

      const { pendingActionId, summary } = await createStaffAnnouncementPending({
        staff,
        message,
        sendVoice,
        conversationId: input.conversationId as string | undefined,
      })

      return {
        success: true,
        data: {
          status: 'pending_approval',
          pendingActionId,
          summary,
          recipients: staff.map((s: { name: string }) => s.name),
          count: staff.length,
          voiceIncluded: sendVoice,
          message:
            'ড্রাফ্ট তৈরি হয়েছে — মালিক Approve করলে পাঠানো হবে। "পাঠানো হয়েছে" বলবেন না।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── update_staff_task_status ──────────────────────────────────────────────────

const update_staff_task_status: AgentTool = {
  name: 'update_staff_task_status',
  description:
    'Updates the status of a specific task (e.g., mark done, cancel, carry). ' +
    'No confirm card needed — use for agent-driven status tracking.',
  input_schema: {
    type: 'object' as const,
    properties: {
      taskId:  { type: 'string', description: 'Task ID' },
      status:  { type: 'string', enum: ['approved','sent','done','carried','cancelled'] },
    },
    required: ['taskId', 'status'],
  },
  handler: async (input) => {
    try {
      const updated = await db.agentStaffTask.update({
        where: { id: String(input.taskId) },
        data: {
          status: String(input.status),
          ...(input.status === 'done' ? { completedAt: new Date() } : {}),
        },
        select: { id: true, title: true, status: true },
      })
      return { success: true, data: updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_marketing_history ─────────────────────────────────────────────────────

const get_marketing_history: AgentTool = {
  name: 'get_marketing_history',
  description:
    'Returns the last promotion date for each product. ' +
    'Use in morning planning to detect products not promoted in 30+ days.',
  input_schema: {
    type: 'object' as const,
    properties: {
      business:     { type: 'string', description: 'Filter by business name (optional)' },
      notSinceDays: { type: 'number', description: 'Only products not promoted in N days (default: 30)' },
    },
  },
  handler: async (input) => {
    try {
      const days   = Number(input.notSinceDays ?? 30)
      const cutoff = new Date(Date.now() - days * 86400 * 1000)
      const where: Record<string, unknown> = { lastPromotedAt: { lt: cutoff } }
      if (input.business) where.business = String(input.business)

      const rows = await db.agentProductMarketingHistory.findMany({
        where,
        orderBy: { lastPromotedAt: 'asc' },
        take: 50,
      })
      return { success: true, data: { cutoffDays: days, products: rows } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── update_staff_task_profile ────────────────────────────────────────────────

const update_staff_task_profile: AgentTool = {
  name: 'update_staff_task_profile',
  description:
    'Updates a staff member\'s task profile — what tasks they should or should not get. ' +
    'Owner says things like "Mustahid কে delivery task দিবি না" → remove that skill. ' +
    'Changes take immediate effect on the next proposal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      staffName:      { type: 'string', description: 'Staff member name (fuzzy match)' },
      addSkills:      { type: 'array', items: { type: 'string' }, description: 'Skills to add' },
      removeSkills:   { type: 'array', items: { type: 'string' }, description: 'Skills to remove' },
      dailyTargetTasks: { type: 'number', description: 'New daily task target count' },
      notes:          { type: 'string', description: 'Updated notes about the staff member' },
    },
    required: ['staffName'],
  },
  handler: async (input) => {
    try {
      const staffName = String(input.staffName).trim()
      const existing = await db.agentKvSetting.findUnique({ where: { key: 'staff_task_profiles' } })
      const profiles = (existing?.value as Record<string, { skills: string[]; dailyTargetTasks: number; notes: string }>) ?? {}

      let matchedKey: string | null = null
      for (const key of Object.keys(profiles)) {
        if (key.toLowerCase().includes(staffName.toLowerCase()) || staffName.toLowerCase().includes(key.toLowerCase())) {
          matchedKey = key
          break
        }
      }
      if (!matchedKey) matchedKey = staffName

      const current = profiles[matchedKey] ?? { skills: [], dailyTargetTasks: 6, notes: '' }

      const addSkills = (input.addSkills as string[]) ?? []
      const removeSkills = (input.removeSkills as string[]) ?? []
      const newSkills = [...new Set([...current.skills, ...addSkills].filter((s) => !removeSkills.includes(s)))]

      profiles[matchedKey] = {
        skills: newSkills,
        dailyTargetTasks: (input.dailyTargetTasks as number) ?? current.dailyTargetTasks,
        notes: (input.notes as string) ?? current.notes,
      }

      await db.agentKvSetting.upsert({
        where: { key: 'staff_task_profiles' },
        create: { key: 'staff_task_profiles', value: profiles },
        update: { value: profiles },
      })

      _resetProfileCache()

      return {
        success: true,
        data: { staffName: matchedKey, profile: profiles[matchedKey] },
        message: `${matchedKey}-এর প্রোফাইল আপডেট হয়েছে। পরবর্তী টাস্ক প্রস্তাবে এই পরিবর্তন কার্যকর হবে।`,
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── approve_pending_staff_message ─────────────────────────────────────────────

const approve_pending_staff_message: AgentTool = {
  name: 'approve_pending_staff_message',
  description:
    'Owner approved a pending staff_announcement draft (message/notice to staff). ' +
    'Flips pending → approved so the worker sends via Telegram. ' +
    'Use when owner says approve/পাঠাও/হ্যাঁ for a staff message draft — NOT for task dispatch (use approve_pending_dispatch).',
  input_schema: {
    type: 'object' as const,
    properties: {
      pendingActionId: { type: 'string', description: 'Specific pending action id (optional — uses latest staff_announcement)' },
    },
  },
  handler: async (input) => {
    try {
      const explicitId = input.pendingActionId as string | undefined
      const row = explicitId
        ? await db.agentPendingAction.findUnique({ where: { id: explicitId } })
        : await db.agentPendingAction.findFirst({
            where: { type: 'staff_announcement', status: 'pending' },
            orderBy: { createdAt: 'desc' },
          })

      if (!row || row.type !== 'staff_announcement') {
        return { success: false, error: 'কোনো pending staff message draft পাওয়া যায়নি।' }
      }
      if (row.status !== 'pending') {
        return {
          success: true,
          data: {
            status: 'already_resolved',
            pendingActionId: row.id,
            currentStatus: row.status,
            message: `ইতিমধ্যে ${row.status} — নতুন draft লাগলে send_staff_announcement আবার চালান।`,
          },
        }
      }

      await db.agentPendingAction.update({
        where: { id: row.id },
        data: { status: 'approved', resolvedAt: new Date() },
      })

      return {
        success: true,
        data: {
          status: 'approved_queued',
          pendingActionId: row.id as string,
          message:
            'Approve হয়েছে — worker স্টাফকে পাঠাবে। নিশ্চিত হওয়ার আগে "পাঠানো হয়েছে" বলবেন না; Staff Monitor দেখুন।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── set_staff_leave ───────────────────────────────────────────────────────────

const set_staff_leave: AgentTool = {
  name: 'set_staff_leave',
  description:
    'Record leave/sick days — on leave: NOT absent, fined, coached, tasked, or in completion stats. ' +
    'Use for "Mustahid kal chhuti", "3 din sick". Check list_staff_leave before assigning tasks.',
  input_schema: {
    type: 'object' as const,
    properties: {
      staffName: { type: 'string' },
      startDate: { type: 'string', description: 'YYYY-MM-DD' },
      endDate: { type: 'string', description: 'YYYY-MM-DD (same as start for one day)' },
      type: { type: 'string', enum: ['leave', 'sick', 'half_day'] },
      reason: { type: 'string' },
    },
    required: ['staffName', 'startDate', 'endDate'],
  },
  handler: async (input) => {
    try {
      const staff = await findStaffByName(input.staffName as string)
      if (!staff) {
        return { success: false, error: `"${input.staffName}" পাওয়া যায়নি।` }
      }
      const startDate = input.startDate as string
      const endDate = input.endDate as string
      await db.staffLeave.create({
        data: {
          staffId: staff.id,
          staffName: staff.name,
          businessId: 'ALMA_LIFESTYLE',
          startDate,
          endDate,
          type: (input.type as string) ?? 'leave',
          reason: (input.reason as string) ?? null,
          status: 'approved',
          approvedBy: 'owner',
        },
      })
      return {
        success: true,
        data: {
          status: 'saved',
          message: `${staff.name} এর ছুটি রেকর্ড হয়েছে (${startDate} – ${endDate})। ঐ দিনগুলোতে absent/fine/task হবে না।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── list_staff_leave ──────────────────────────────────────────────────────────

const list_staff_leave: AgentTool = {
  name: 'list_staff_leave',
  description: 'List upcoming/active staff leave. Use when owner asks "ke chhuti te ache", or before planning tasks.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const today = dhakaToday()
      const rows = await db.staffLeave.findMany({
        where: { status: 'approved', endDate: { gte: today } },
        orderBy: { startDate: 'asc' },
      })
      return {
        success: true,
        data: {
          count: rows.length,
          leave: rows.map((r: {
            staffName: string | null
            startDate: string
            endDate: string
            type: string
            reason: string | null
          }) => ({
            name: r.staffName,
            startDate: r.startDate,
            endDate: r.endDate,
            type: r.type,
            reason: r.reason,
          })),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const STAFF_TOOLS: AgentTool[] = [
  prepare_staff_task_proposal,
  get_all_staff,
  get_staff_tasks,
  propose_staff_tasks,
  merge_into_proposal,
  approve_pending_dispatch,
  approve_pending_staff_message,
  get_dispatch_status,
  get_lunch_status,
  set_staff_leave,
  list_staff_leave,
  get_current_proposal,
  correct_and_redispatch_staff_tasks,
  approve_and_dispatch_tasks,
  add_staff_task_now,
  send_dispatch_correction_notice,
  send_staff_announcement,
  update_staff_task_status,
  get_marketing_history,
  update_staff_task_profile,
]
