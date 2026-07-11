import { prisma } from '@/lib/prisma'
import { formatReminderConfirmation } from '@/agent/lib/reminder-rrule'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// Owner todos live in the SAME `agent_todos` store the owner sees in the chat
// dock and the Monitor — one source of truth. (Previously these tools wrote to a
// separate `agent_owner_todos` table, so owner tasks showed in the Monitor but
// NOT the dock, and vice-versa.) Status vocabulary maps onto agentTodo statuses:
//   open  → pending (visible/active)   done → completed   dropped → cancelled
const OPEN_STATUSES = ['pending', 'in_progress', 'running']
const BUSINESS_ID = 'ALMA_LIFESTYLE'

function mapStatusFilter(status: string): Record<string, unknown> {
  if (status === 'all') return {}
  if (status === 'done') return { status: 'completed' }
  if (status === 'dropped') return { status: 'cancelled' }
  // open
  return { status: { in: OPEN_STATUSES } }
}

function uiStatus(dbStatus: string): 'open' | 'done' | 'dropped' {
  if (dbStatus === 'completed') return 'done'
  if (dbStatus === 'cancelled' || dbStatus === 'failed') return 'dropped'
  return 'open'
}

function buildDescription(detail?: unknown, dueHint?: unknown): string | null {
  const d = detail ? String(detail).trim() : ''
  const hint = dueHint ? String(dueHint).trim() : ''
  const parts = [d, hint ? `🕒 ${hint}` : ''].filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

const add_owner_todo: AgentTool = {
  name: 'add_owner_todo',
  description:
    'Track a personal/business TODO that the OWNER himself needs to do (not a staff task). Use for things ' +
    'like "Dubai shipment paperwork sort korte hobe", "X supplier ke call korte hobe". If the owner gives a ' +
    'DAY or TIME ("agamikal", "kal shokale", "raat 9 tay") pass dueAtIso — the todo gets that due date AND a ' +
    'real reminder is auto-set for that moment (never just SAY you will remind; this tool call IS the ' +
    'reminder). For a pure timed reminder with no todo use set_reminder; for staff work use add_staff_task_now.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short todo title' },
      detail: { type: 'string', description: 'Optional details' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Default normal' },
      dueAtIso: {
        type: 'string',
        description:
          'Optional ISO 8601 datetime (resolve natural language like "agamikal same time" to Asia/Dhaka ' +
          'time first). Sets the todo due date AND auto-creates a reminder at that moment.',
      },
      dueHint: { type: 'string', description: 'Optional free-text timing hint, e.g. "এই সপ্তাহে" (not a hard timer)' },
      conversationId: { type: 'string' },
    },
    required: ['title'],
  },
  handler: async (input) => {
    const title = String(input.title ?? '').trim()
    if (!title) return { success: false, error: 'title is required' }

    let dueAt: Date | null = null
    if (input.dueAtIso) {
      dueAt = new Date(String(input.dueAtIso))
      if (Number.isNaN(dueAt.getTime())) {
        return { success: false, error: 'dueAtIso must be a valid ISO 8601 datetime' }
      }
    }

    try {
      const todo = await db.agentTodo.create({
        data: {
          title,
          description: buildDescription(input.detail, input.dueHint),
          priority: ['low', 'normal', 'high'].includes(String(input.priority)) ? String(input.priority) : 'normal',
          source: 'owner',
          status: 'pending',
          dueDate: dueAt,
          businessId: BUSINESS_ID,
        },
      })

      // Time given → set a REAL reminder in the same call. The old flow relied on
      // the head remembering a separate set_reminder call; when it forgot, the
      // owner was promised a reminder that never existed anywhere.
      let reminderNote = ''
      if (dueAt && dueAt.getTime() > Date.now()) {
        await db.agentReminder.create({
          data: {
            title,
            body: input.detail ? String(input.detail).trim() : null,
            dueAt,
            tier: 1,
            voice: true,
            status: 'pending',
            sourceConversationId: input.conversationId ? String(input.conversationId) : null,
          },
        })
        reminderNote = ` ${formatReminderConfirmation(title, dueAt)}`
      }

      return {
        success: true,
        data: {
          id: todo.id,
          title: todo.title,
          reminderSet: Boolean(reminderNote),
          message: `টুডু যুক্ত হয়েছে।${reminderNote}`,
        },
      }
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
      const todos = await db.agentTodo.findMany({
        where: { businessId: BUSINESS_ID, source: 'owner', ...mapStatusFilter(status) },
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
              description: string | null
              priority: string
              status: string
              createdAt: Date
            }) => ({
              id: t.id,
              title: t.title,
              detail: t.description,
              priority: t.priority,
              status: uiStatus(t.status),
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
    'Mark an owner todo done, or change its priority/detail, or REMOVE (drop) it. Use when the owner says ' +
    '"oita hoye geche", "X kaj ta done", "oita baad dao", "list theke soraw". NOTE: status=dropped is ' +
    'destructive — it does NOT remove anything immediately; it returns a confirm card (actionType ' +
    'todo_cancel). Only after Boss approves does the real removal happen, and the row then shows a red cross ' +
    'with the agent name. Never claim a todo is removed before the card is approved.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Todo id' },
      titleMatch: { type: 'string', description: 'Alternative to id — match an open todo by partial title' },
      status: { type: 'string', enum: ['open', 'done', 'dropped'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      detail: { type: 'string' },
      conversationId: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      let id = input.id ? String(input.id) : null
      if (!id && input.titleMatch) {
        const match = await db.agentTodo.findFirst({
          where: {
            businessId: BUSINESS_ID,
            source: 'owner',
            status: { in: OPEN_STATUSES },
            title: { contains: String(input.titleMatch), mode: 'insensitive' },
          },
          orderBy: { createdAt: 'desc' },
        })
        if (!match) return { success: false, error: `"${input.titleMatch}" নামে কোনো open টুডু পাওয়া যায়নি।` }
        id = match.id
      }
      if (!id) return { success: false, error: 'id or titleMatch required' }

      const status = input.status ? String(input.status) : null

      // Removal/cancel is destructive → confirm-gate (Boss's rule: confirm before
      // any destructive action except salah). Nothing is changed optimistically:
      // the real soft-cancel happens only after the owner approves the card, and
      // the todolist row then shows a red cross + the agent's name. Mirrors the
      // work-todo remove flow so owner + agent todos behave identically.
      if (status === 'dropped') {
        const existing = await db.agentTodo.findUnique({ where: { id } })
        if (!existing) return { success: false, error: 'todo not found' }
        if (existing.status === 'cancelled') {
          return {
            success: true,
            data: { id, title: existing.title, message: `"${existing.title}" আগেই তালিকা থেকে সরানো হয়েছে।` },
          }
        }
        const summary =
          `🗑️ টুডু তালিকা থেকে সরানো হবে\n\n"${existing.title}"\n\n` +
          `(সরালে তালিকা থেকে চলে যাবে, তবে রেকর্ডে থেকে যাবে — চাইলে ফেরানো যাবে।)`
        const conversationId = input.conversationId ? String(input.conversationId) : null
        const pending = await db.agentPendingAction.create({
          data: {
            conversationId,
            type: 'todo_cancel',
            payload: { todoId: id, title: existing.title, businessId: BUSINESS_ID, conversationId },
            summary,
            costEstimate: 0,
            status: 'pending',
          },
        })
        return {
          success: true,
          data: {
            pendingActionId: pending.id as string,
            summary,
            costEstimate: 0,
            actionType: 'todo_cancel',
            message:
              `"${existing.title}" সরানোর জন্য Boss-এর confirm দরকার — approve করলে তালিকা থেকে সরবে এবং ` +
              `লাল ক্রস + এজেন্টের নাম সহ দেখাবে।`,
          },
        }
      }

      const data: Record<string, unknown> = {}
      if (status === 'done') { data.status = 'completed'; data.completedAt = new Date() }
      else if (status === 'open') { data.status = 'pending'; data.completedAt = null }
      if (input.priority) data.priority = String(input.priority)
      if (input.detail != null) data.description = String(input.detail)
      if (!Object.keys(data).length) return { success: false, error: 'কিছু পরিবর্তন দিন (status/priority/detail)।' }

      const updated = await db.agentTodo.update({ where: { id }, data })
      return {
        success: true,
        data: { id: updated.id, title: updated.title, status: uiStatus(updated.status), message: 'টুডু আপডেট হয়েছে।' },
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
## OWNER টুডু ট্র্যাকার (Cursor/Claude-এর মতো নিজের todolist চালান)
owner-এর নিজের কাজ (staff task নয়) ট্র্যাক করতে add_owner_todo / list_owner_todos / update_owner_todo ব্যবহার করুন। এই তালিকাটাকে নিজের working list ভাবুন — কাজ শুরুর আগে list দেখুন, যোগ করুন, শেষ হলে mark করুন।
- owner "X করতে হবে" বললে → add_owner_todo। **দিন/সময় দিলে ("আগামীকাল", "কাল সকালে", "রাত ৯টায়") → dueAtIso-তে Asia/Dhaka সময় resolve করে দিন — টুডুর due date বসে এবং ওই মুহূর্তে reminder নিজে-নিজে সেট হয়।** "মনে করিয়ে দেব" শুধু মুখে বলবেন না — dueAtIso বা set_reminder call করলেই কেবল reminder বাস্তবে আছে।
- টুডু ছাড়া শুধু timed reminder হলে → set_reminder। স্টাফের কাজ হলে → add_staff_task_now।
- owner-এর টুডু এখন ERP-র সব পেজের উপরের "টুডু" বারে দেখা যায় (agent chat-এর পুরনো প্যানেল নেই) — টুডু done/remove না হওয়া পর্যন্ত তালিকায় থাকে, দিন পেরোলেও হারায় না।
- কাজ হয়ে গেলে ("oita done", "hoye geche") → update_owner_todo status=done।
- **সরাতে/বাদ দিতে বললে ("baad dao", "list theke soraw", "cancel") → update_owner_todo status=dropped।**
  এটা সাথে সাথে সরায় না — একটা **confirm card** ফেরত আসে। Boss Approve করলেই বাস্তবে সরে, তারপর সেই row লাল ক্রস + এজেন্টের নাম সহ দেখায়। **Approve হওয়ার আগে "সরিয়ে দিলাম" বলবেন না** — আগে বাস্তবে হোক, তারপর তালিকায় mark হবে (ঠিক যেমন Claude কাজ শেষ হলে তবেই todo done করে)।
- সকালের এক জায়গায় সব overview চাইলে → get_daily_digest।
- এই todo গুলো owner চ্যাটের todo তালিকা ও Monitor — দুই জায়গাতেই একই (এক source)।
`
