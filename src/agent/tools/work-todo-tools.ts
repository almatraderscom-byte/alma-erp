import { prisma } from '@/lib/prisma'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { sortTodosForDisplay } from '@/agent/lib/todo-sort'
import type { AgentTool } from './registry'

const manage_work_todos: AgentTool = {
  name: 'manage_work_todos',
  description:
    'Manage the single daily todo list (agent office tasks on top, owner requests below). ' +
    'When owner asks you to do something in chat: add with source=owner. ' +
    'When owner says cancel/remove: action=remove. Owner task complete → removed from list. ' +
    'Office tasks are source=day_shift (scheduler) — do not duplicate.\n\n' +
    'SOURCE RULES (the owner\'s dashboard "আমার টুডু" widget shows ONLY source=owner + source=owner_action):\n' +
    '- source=owner → the owner\'s OWN task (he asked to add it, or it is his personal note). Persists on his dashboard until HE marks it done.\n' +
    '- source=owner_action → something YOU need the OWNER to do/decide today (approve a card, send a payment, reply to a question). Shows on his dashboard today only, resets at day end — re-raise tomorrow if still needed.\n' +
    '- source=agent → your own working item. NEVER visible on the owner\'s dashboard — do not use it for things you need from him.\n\n' +
    'WORKFLOW:\n' +
    '- Morning office: day_shift scheduler seeds agent office tasks at top of the same todo list\n' +
    '- During chat: owner request → add source=owner, work on it, complete → auto-removed\n' +
    '- You need the owner\'s action → add source=owner_action (short imperative title in Bangla)\n' +
    '- Owner says বাদ দাও / cancel → action=remove\n' +
    '- Evening: action=summary for day review\n' +
    '- Always update description with results when completing agent office tasks',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'update', 'complete', 'remove', 'summary'],
        description: 'list | add | update | complete | remove (delete/cancel) | summary',
      },
      id: { type: 'string', description: 'Todo ID (for update/complete/remove)' },
      title: { type: 'string', description: 'Task title (for add)' },
      description: { type: 'string', description: 'Task details or completion result' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority level' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'New status (for update)' },
      source: {
        type: 'string',
        enum: ['owner', 'agent', 'owner_action'],
        description:
          'owner when Boss asked in chat (persists on his dashboard until done); ' +
          'owner_action when YOU need Boss to act/decide today (his dashboard, resets at day end); ' +
          'agent for your own ad-hoc tasks (never on his dashboard; not day_shift — scheduler owns those)',
      },
      dueDate: { type: 'string', description: 'ISO date YYYY-MM-DD for when Boss should do this (e.g. tomorrow from evening intake)' },
    },
    required: ['action'],
  },
  handler: async (input) => {
    const action = String(input.action)
    const businessId = String(input.businessId ?? 'ALMA_LIFESTYLE')

    try {
      if (action === 'list') {
        const todos = await prisma.agentTodo.findMany({
          where: { businessId, status: { notIn: ['cancelled'] } },
          orderBy: [{ createdAt: 'desc' }],
        })
        const sorted = sortTodosForDisplay(todos)
        const active = sorted.filter(t => t.status !== 'completed')
        const completed = sorted.filter(t => t.status === 'completed')
        return {
          success: true,
          data: {
            active_count: active.length,
            completed_today: completed.filter(t => {
              const today = new Date().toISOString().slice(0, 10)
              return t.completedAt && t.completedAt.toISOString().slice(0, 10) === today
            }).length,
            todos: sorted.map(t => ({
              id: t.id,
              title: t.title,
              description: t.description,
              priority: t.priority,
              status: t.status,
              source: t.source,
              createdAt: t.createdAt.toISOString(),
              completedAt: t.completedAt?.toISOString() ?? null,
            })),
          },
        }
      }

      if (action === 'add') {
        const title = String(input.title ?? '').trim()
        if (!title) return { success: false, error: 'title is required' }

        let dueDate: Date | null = null
        if (input.dueDate) {
          const ymd = String(input.dueDate).slice(0, 10)
          dueDate = new Date(`${ymd}T00:00:00+06:00`)
        }

        const todo = await prisma.agentTodo.create({
          data: {
            title,
            description: input.description ? String(input.description).trim() : null,
            priority: String(input.priority ?? 'normal'),
            source: input.source === 'owner' || input.source === 'owner_action'
              ? String(input.source)
              : 'agent',
            businessId,
            ...(dueDate ? { dueDate } : {}),
          },
        })
        return {
          success: true,
          data: { id: todo.id, title: todo.title, message: `টুডু "${title}" যুক্ত হয়েছে।` },
        }
      }

      if (action === 'update') {
        const id = String(input.id ?? '')
        if (!id) return { success: false, error: 'id is required for update' }

        const data: Record<string, unknown> = {}
        if (input.status) data.status = String(input.status)
        if (input.description) data.description = String(input.description)
        if (input.priority) data.priority = String(input.priority)
        if (input.title) data.title = String(input.title)

        const todo = await prisma.agentTodo.update({ where: { id }, data })
        return {
          success: true,
          data: { id: todo.id, title: todo.title, status: todo.status, message: 'আপডেট হয়েছে।' },
        }
      }

      if (action === 'complete') {
        const id = String(input.id ?? '')
        if (!id) return { success: false, error: 'id is required for complete' }

        const result = input.description ? String(input.description).trim() : null
        const before = await prisma.agentTodo.findUnique({ where: { id } })
        if (!before) return { success: false, error: 'todo not found' }

        if (before.source === 'owner') {
          // Soft-complete: mark completed (recoverable), never hard-delete.
          await prisma.agentTodo.update({
            where: { id },
            data: { status: 'completed', completedAt: new Date(), ...(result ? { description: result } : {}) },
          })
          const completionLine = result
            ? `✅ ${before.title}\n\n📋 ${result}`
            : `✅ ${before.title}`
          void sendOwnerText(completionLine).catch(() => {})
          return {
            success: true,
            data: {
              id: before.id,
              title: before.title,
              status: 'completed',
              removed: true,
              message: `✅ "${before.title}" সম্পন্ন — তালিকা থেকে সরানো হয়েছে।`,
            },
          }
        }

        const todo = await prisma.agentTodo.update({
          where: { id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            ...(result ? { description: result } : {}),
          },
        })

        const completionLine = result
          ? `✅ ${todo.title}\n\n📋 ${result}`
          : `✅ ${todo.title}`
        void sendOwnerText(completionLine).catch(() => {})

        return {
          success: true,
          data: {
            id: todo.id,
            title: todo.title,
            status: 'completed',
            message: `✅ "${todo.title}" সম্পন্ন।`,
          },
        }
      }

      if (action === 'remove') {
        const id = String(input.id ?? '')
        if (!id) return { success: false, error: 'id is required for remove' }

        const existing = await prisma.agentTodo.findUnique({ where: { id } })
        if (!existing) return { success: false, error: 'todo not found' }
        if (existing.status === 'cancelled') {
          return {
            success: true,
            data: { id, title: existing.title, message: `"${existing.title}" আগেই তালিকা থেকে সরানো হয়েছে।` },
          }
        }

        // Confirm-first (Boss's rule: confirm before any destructive action except salah).
        // Soft-cancel happens only after the owner approves the card; nothing is hard-deleted.
        const summary =
          `🗑️ টুডু তালিকা থেকে সরানো হবে\n\n"${existing.title}"\n\n` +
          `(সরালে তালিকা থেকে চলে যাবে, তবে রেকর্ড থেকে যাবে — চাইলে ফেরানো যাবে।)`
        const conversationId = input.conversationId ? String(input.conversationId) : null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pending = await (prisma as any).agentPendingAction.create({
          data: {
            conversationId,
            type: 'todo_cancel',
            payload: { todoId: id, title: existing.title, businessId, conversationId },
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
            message: `"${existing.title}" সরানোর জন্য Boss-এর অনুমোদন দরকার — confirm করলে তালিকা থেকে সরে যাবে।`,
          },
        }
      }

      if (action === 'summary') {
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        const allTodos = await prisma.agentTodo.findMany({
          where: { businessId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })

        const completed = allTodos.filter(t =>
          t.status === 'completed' && t.completedAt && t.completedAt >= today
        )
        const pending = allTodos.filter(t => t.status === 'pending')
        const inProgress = allTodos.filter(t => t.status === 'in_progress')

        return {
          success: true,
          data: {
            date: today.toISOString().slice(0, 10),
            completed_today: completed.length,
            still_pending: pending.length,
            in_progress: inProgress.length,
            completed_items: completed.map(t => ({
              title: t.title,
              result: t.description,
              source: t.source,
            })),
            pending_items: pending.map(t => ({
              id: t.id,
              title: t.title,
              priority: t.priority,
              source: t.source,
            })),
            in_progress_items: inProgress.map(t => ({
              id: t.id,
              title: t.title,
              priority: t.priority,
              source: t.source,
            })),
          },
        }
      }

      return { success: false, error: `Unknown action: ${action}` }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const WORK_TODO_TOOLS: AgentTool[] = [manage_work_todos]

export const WORK_TODO_PROMPT = `
## এজেন্ট ওয়ার্ক ট্র্যাকার (একটি Todo লিস্ট)
একই তালিকায় দুই ধরনের কাজ — **উপরে Agent office** (day_shift/scheduler), **নিচে Boss-এর request** (source=owner)। আলাদা UI নেই।

### সকালের office (day_shift):
- Scheduler আপনার office কাজগুলো source=day_shift দিয়ে তালিকার **উপরে** যোগ করে
- Chat-এ Cursor-style step-by-step update দিন; manage_work_todos দিয়ে status sync করুন

### Boss chat-এ কিছু বললে:
- "X করো" → manage_work_todos action=add, **source=owner** — তালিকায় agent কাজের **নিচে** যুক্ত হবে
- কাজ শেষ → action=complete + ফলাফল → owner todo তালিকা থেকে সরে যাবে (completed হিসেবে রেকর্ডে থাকে)
- "বাদ দাও" / cancel / "pending থেকে সরাও" → action=remove → একটা **confirm card** আসবে; Boss Approve করলেই সরবে

### নিয়ম (Cursor/Claude-এর মতো নিজের todolist চালান):
- এই তালিকাটাকে নিজের **working list** ভাবুন — কাজ শুরুর আগে list দেখুন/যোগ করুন, শেষ হলে তবেই mark করুন
- একই লিস্ট — office tasks সবসময় owner tasks-এর উপরে sort হয়
- day_shift todos নিজে duplicate করবেন না
- **কোনো টুডু কখনো hard-delete হয় না** — remove = soft cancel (status=cancelled), complete = soft (status=completed)। তাই ভুল হলে ফেরানো যায়
- **remove সবসময় confirm card দিয়ে হয়** (Boss-এর নিয়ম: salah ছাড়া যেকোনো destructive কাজে আগে confirm)। কার্ড তৈরি হলে Boss-কে বলুন "confirm করলে সরিয়ে দেব"
- **আগে বাস্তবে হোক, তারপর তালিকায় mark হবে** — approve হওয়ার আগে "সরিয়ে দিলাম" বলবেন না। approve হলে row লাল ক্রস + এজেন্টের নাম সহ দেখায় (ঠিক যেমন Claude কাজ শেষ হলে তবেই todo done করে)
- description-এ ফলাফল লিখুন
`
