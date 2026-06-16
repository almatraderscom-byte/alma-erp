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
    'WORKFLOW:\n' +
    '- Morning office: day_shift scheduler seeds agent office tasks at top of the same todo list\n' +
    '- During chat: owner request → add source=owner, work on it, complete → auto-removed\n' +
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
        enum: ['owner', 'agent'],
        description: 'owner when Sir asked in chat; agent for your own ad-hoc tasks (not day_shift — scheduler owns those)',
      },
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

        const todo = await prisma.agentTodo.create({
          data: {
            title,
            description: input.description ? String(input.description).trim() : null,
            priority: String(input.priority ?? 'normal'),
            source: input.source === 'owner' ? 'owner' : 'agent',
            businessId,
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
          await prisma.agentTodo.delete({ where: { id } })
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

        await prisma.agentTodo.delete({ where: { id } })
        return {
          success: true,
          data: {
            id,
            title: existing.title,
            message: `"${existing.title}" তালিকা থেকে সরানো হয়েছে।`,
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
একই তালিকায় দুই ধরনের কাজ — **উপরে Agent office** (day_shift/scheduler), **নিচে Sir-এর request** (source=owner)। আলাদা UI নেই।

### সকালের office (day_shift):
- Scheduler আপনার office কাজগুলো source=day_shift দিয়ে তালিকার **উপরে** যোগ করে
- Chat-এ Cursor-style step-by-step update দিন; manage_work_todos দিয়ে status sync করুন

### Sir chat-এ কিছু বললে:
- "X করো" → manage_work_todos action=add, **source=owner** — তালিকায় agent কাজের **নিচে** যুক্ত হবে
- কাজ শেষ → action=complete + ফলাফল → owner todo **অটো তালিকা থেকে সরে যাবে**
- "বাদ দাও" / cancel → action=remove

### নিয়ম:
- একই লিস্ট — office tasks সবসময় owner tasks-এর উপরে sort হয়
- day_shift todos নিজে duplicate করবেন না
- Office task complete করলে completed হিসেবে থাকে; owner task complete = delete
- description-এ ফলাফল লিখুন
`
