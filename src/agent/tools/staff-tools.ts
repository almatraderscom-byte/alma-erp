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
  loadProposedTasksForDate,
  buildDispatchSummary,
} from '@/agent/lib/staff-dispatch-sync'
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

const APP_URL = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const INTERNAL_TOKEN = process.env.AGENT_INTERNAL_TOKEN || ''

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
    'Add or edit tasks within the CURRENTLY pending (unapproved) staff proposal, preserving existing tasks. ' +
    'Use when the owner requests changes/additions while a proposal is active. ' +
    'Re-shows the full updated proposal for approval. Do NOT use add_staff_task_now or propose_staff_tasks for this.',
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

      return {
        success: true,
        data: {
          date,
          taskCounts,
          pendingActionStatus: pendingAction?.status ?? 'none',
          pendingActionCreatedAt: pendingAction?.createdAt ?? null,
          deliveryByStaff,
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
    'Wrong tasks were already sent. Cancels sent/approved tasks for the date, then dispatches the CURRENT proposed list from DB. ' +
    'Use when owner says "ভুল টাস্ক গেছে", "আগেরটা বাদ দিয়ে ঠিকটা পাঠাও", "correct task পাঠাও". ' +
    'Correct proposed tasks MUST already be in DB (merge_into_proposal / propose_staff_tasks) before calling this.',
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

      const cancelled = await db.agentStaffTask.updateMany({
        where: {
          proposedFor: new Date(date),
          status: { in: ['sent', 'approved'] },
        },
        data: { status: 'cancelled' },
      })

      const openActions = await db.agentPendingAction.findMany({
        where: {
          type: 'dispatch_staff_tasks',
          status: { in: ['pending', 'approved'] },
        },
        select: { id: true, payload: true },
      })
      for (const a of openActions) {
        const p = a.payload as { date?: string }
        if (p.date === date) {
          await db.agentPendingAction.update({
            where: { id: a.id },
            data: {
              status: 'superseded',
              resolvedAt: new Date(),
              result: { reason: 'corrected_redispatch' },
            },
          })
        }
      }

      const result = await refreshAndApproveDispatch(date)
      if (!result.ok) {
        return { success: false, error: 'Redispatch failed — no proposed tasks after cancel.' }
      }

      return {
        success: true,
        data: {
          status: 'corrected_redispatch_queued',
          date,
          cancelledWrongTasks: cancelled.count,
          redispatchTaskCount: result.taskCount,
          taskIds: result.taskIds,
          summaryBangla: buildDispatchSummary(date, proposed),
          message:
            `${cancelled.count}টি ভুল টাস্ক cancelled, ${result.taskCount}টি সঠিক টাস্ক dispatch queue-তে। ` +
            'স্টাফকে send_staff_announcement দিয়ে জানান আগের মেসেজ বাতিল — নিচের নতুন তালিকা সঠিক।',
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

// ── send_staff_announcement ───────────────────────────────────────────────────

const send_staff_announcement: AgentTool = {
  name: 'send_staff_announcement',
  description:
    'Send an announcement/news/notice to staff via Telegram (text + voice note). ' +
    'NOT a task — no Done buttons, no completion tracking. ' +
    'Use for: rule changes, policy updates, office notices, reminders, news. ' +
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

      const res = await fetch(`${APP_URL}/api/assistant/internal/staff-announcement`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INTERNAL_TOKEN}`,
        },
        body: JSON.stringify({
          message,
          staffChatIds: staff.map((s: { id: string; name: string; telegramChatId: string | null }) => ({
            id: s.id,
            name: s.name,
            chatId: s.telegramChatId,
          })),
          sendVoice,
        }),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { success: false, error: `Failed to queue announcement: HTTP ${res.status} ${body.slice(0, 120)}` }
      }

      const queued = await res.json()
      return {
        success: true,
        data: {
          status: 'sent',
          actionId: queued.actionId,
          sentTo: staff.map((s: { name: string }) => s.name),
          count: staff.length,
          voiceIncluded: sendVoice,
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

export const STAFF_TOOLS: AgentTool[] = [
  prepare_staff_task_proposal,
  get_all_staff,
  get_staff_tasks,
  propose_staff_tasks,
  merge_into_proposal,
  approve_pending_dispatch,
  get_dispatch_status,
  get_current_proposal,
  correct_and_redispatch_staff_tasks,
  approve_and_dispatch_tasks,
  add_staff_task_now,
  send_staff_announcement,
  update_staff_task_status,
  get_marketing_history,
  update_staff_task_profile,
]
