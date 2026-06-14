import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const add_owner_todo: AgentTool = {
  name: 'add_owner_todo',
  description:
    'Track an open-ended personal/business TODO that the OWNER himself needs to do (not a staff task, not a ' +
    'timed reminder). Use for things like "Dubai shipment paperwork sort korte hobe", "X supplier ke call ' +
    'korte hobe" — items with no fixed time that should be tracked until done and gently nudged if they ' +
    'linger. For time-specific reminders use set_reminder instead; for staff work use add_staff_task_now.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short todo title' },
      detail: { type: 'string', description: 'Optional details' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Default normal' },
      dueHint: { type: 'string', description: 'Optional free-text timing hint, e.g. "এই সপ্তাহে" (not a hard timer)' },
      conversationId: { type: 'string' },
    },
    required: ['title'],
  },
  handler: async (input) => {
    const title = String(input.title ?? '').trim()
    if (!title) return { success: false, error: 'title is required' }
    try {
      const todo = await db.agentOwnerTodo.create({
        data: {
          title,
          detail: input.detail ? String(input.detail) : null,
          priority: ['low', 'normal', 'high'].includes(String(input.priority)) ? String(input.priority) : 'normal',
          dueHint: input.dueHint ? String(input.dueHint) : null,
          sourceConversationId: input.conversationId ? String(input.conversationId) : null,
        },
      })
      return { success: true, data: { id: todo.id, title: todo.title, message: 'টুডু যুক্ত হয়েছে।' } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const list_owner_todos: AgentTool = {
  name: 'list_owner_todos',
  description:
    'List the owner\'s open (or all) personal/business todos. Use when the owner asks "amar ki ki kaj baki", "todo list dekhao", or before the daily digest.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', enum: ['open', 'done', 'dropped', 'all'], description: 'Default open' },
    },
  },
  handler: async (input) => {
    const status = String(input.status ?? 'open')
    try {
      const where = status === 'all' ? {} : { status }
      const todos = await db.agentOwnerTodo.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: 50,
      })
      return {
        success: true,
        data: {
          count: todos.length,
          todos: todos.map(
            (t: {
              id: string
              title: string
              detail: string | null
              priority: string
              status: string
              dueHint: string | null
              createdAt: Date
            }) => ({
              id: t.id,
              title: t.title,
              detail: t.detail,
              priority: t.priority,
              status: t.status,
              dueHint: t.dueHint,
              ageDays: Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 86400000),
            }),
          ),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const update_owner_todo: AgentTool = {
  name: 'update_owner_todo',
  description:
    'Mark an owner todo done/dropped, or change its priority/detail. Use when the owner says "oita hoye geche", "X kaj ta done", "oita baad dao".',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Todo id' },
      titleMatch: { type: 'string', description: 'Alternative to id — match an open todo by partial title' },
      status: { type: 'string', enum: ['open', 'done', 'dropped'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      detail: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      let id = input.id ? String(input.id) : null
      if (!id && input.titleMatch) {
        const match = await db.agentOwnerTodo.findFirst({
          where: { status: 'open', title: { contains: String(input.titleMatch), mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' },
        })
        if (!match) return { success: false, error: `"${input.titleMatch}" নামে কোনো open টুডু পাওয়া যায়নি।` }
        id = match.id
      }
      if (!id) return { success: false, error: 'id or titleMatch required' }

      const data: Record<string, unknown> = {}
      if (input.status) {
        data.status = String(input.status)
        if (input.status === 'done') data.completedAt = new Date()
      }
      if (input.priority) data.priority = String(input.priority)
      if (input.detail != null) data.detail = String(input.detail)
      if (!Object.keys(data).length) return { success: false, error: 'কিছু পরিবর্তন দিন (status/priority/detail)।' }

      const updated = await db.agentOwnerTodo.update({ where: { id }, data })
      return {
        success: true,
        data: { id: updated.id, title: updated.title, status: updated.status, message: 'টুডু আপডেট হয়েছে।' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_daily_digest: AgentTool = {
  name: 'get_daily_digest',
  description:
    'Unified daily digest: business briefing + website health + pending approvals + open owner todos + ' +
    'lingering todos that need attention. Use when the owner asks "ajker overview", "din er shururite ki ' +
    'dekhbo", "sob kichu ek jaygায় dekhao", or for a proactive morning rundown.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const { buildOwnerDailyDigest } = await import('@/lib/owner-daily-digest')
      const digest = await buildOwnerDailyDigest()
      return { success: true, data: digest }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const OWNER_TODO_TOOLS: AgentTool[] = [add_owner_todo, list_owner_todos, update_owner_todo, get_daily_digest]

export const OWNER_TODO_ROLE_PROMPT = `
## OWNER টুডু ট্র্যাকার
owner-এর নিজের কাজ (staff task নয়, timed reminder নয়) ট্র্যাক করতে add_owner_todo / list_owner_todos / update_owner_todo ব্যবহার করুন।
- সময়-নির্দিষ্ট হলে → set_reminder। স্টাফের কাজ হলে → add_staff_task_now। owner নিজে করবেন এমন open কাজ → owner todo।
- owner "X করতে হবে" বললে এবং কোনো নির্দিষ্ট সময় না দিলে → add_owner_todo।
- কাজ হয়ে গেলে ("oita done", "hoye geche") → update_owner_todo status=done।
- সকালের এক জায়গায় সব overview চাইলে → get_daily_digest।
`
