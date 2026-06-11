/**
 * Phase 6A — Staff manager agent tools.
 * These run in the agent's tool-call loop (Vercel, not worker).
 * The agent proposes/approves tasks; the worker handles dispatch timing.
 */
import { prisma } from '@/lib/prisma'
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
            type:       { type: 'string', enum: ['ad_creative','product_content','stock_check','listing_update','order_followup','misc'] },
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

      return { success: true, data: { date, tasksCreated: created.count } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── approve_and_dispatch_tasks ────────────────────────────────────────────────

const approve_and_dispatch_tasks: AgentTool = {
  name: 'approve_and_dispatch_tasks',
  description:
    'Approves all proposed tasks for a date and queues them for dispatch to staff via Telegram. ' +
    'Creates a PENDING ACTION (confirm card) — owner must approve before dispatch happens. ' +
    'Use after propose_staff_tasks to get the approval card.',
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
          message:  'Dispatch pending owner approval.',
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
    'Adds a single task to today\'s list for a staff member mid-day. ' +
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

export const STAFF_TOOLS: AgentTool[] = [
  get_all_staff,
  get_staff_tasks,
  propose_staff_tasks,
  approve_and_dispatch_tasks,
  add_staff_task_now,
  update_staff_task_status,
  get_marketing_history,
]
