import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

const manage_work_todos: AgentTool = {
  name: 'manage_work_todos',
  description:
    'Manage the agent\'s daily work todo list. Use this to plan work at the start of the day, ' +
    'track progress as tasks complete, and provide end-of-day summaries. The owner sees this ' +
    'list on the agent homepage. Actions: list, add, update, complete, summary.\n\n' +
    'WORKFLOW:\n' +
    '- Morning: list current todos, then add today\'s planned tasks\n' +
    '- During work: mark tasks in_progress, then completed with results\n' +
    '- When owner asks something: add it as a new todo, work on it, mark complete\n' +
    '- Evening: call with action=summary for a full day review\n' +
    '- Always update description with results/outcome when completing',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'update', 'complete', 'summary'],
        description: 'list=show all active, add=create new, update=change status/details, complete=mark done with result, summary=end-of-day digest',
      },
      id: { type: 'string', description: 'Todo ID (for update/complete)' },
      title: { type: 'string', description: 'Task title (for add)' },
      description: { type: 'string', description: 'Task details or completion result' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority level' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'New status (for update)' },
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
          orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
        })
        const active = todos.filter(t => t.status !== 'completed')
        const completed = todos.filter(t => t.status === 'completed')
        return {
          success: true,
          data: {
            active_count: active.length,
            completed_today: completed.filter(t => {
              const today = new Date().toISOString().slice(0, 10)
              return t.completedAt && t.completedAt.toISOString().slice(0, 10) === today
            }).length,
            todos: todos.map(t => ({
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
            source: 'agent',
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
        const todo = await prisma.agentTodo.update({
          where: { id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            ...(result ? { description: result } : {}),
          },
        })
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
## এজেন্ট ওয়ার্ক ট্র্যাকার (TodoList System)
আপনি একটি TodoList সিস্টেম ব্যবহার করে কাজ ট্র্যাক করবেন — ঠিক যেভাবে একজন chief of staff তার দৈনিক কার্যতালিকা manage করে।

### দৈনিক কর্মপ্রবাহ:
1. **সকাল**: manage_work_todos action=list দিয়ে বর্তমান টুডু দেখুন, তারপর আজকের পরিকল্পিত কাজ action=add দিয়ে যোগ করুন
2. **কাজ চলাকালীন**: প্রতিটি কাজ শুরুর আগে status=in_progress করুন, শেষ হলে action=complete + ফলাফল description-এ দিন
3. **মালিক কিছু বললে**: নতুন todo যোগ করুন, কাজ করুন, সম্পন্ন হলে রিপোর্ট দিন
4. **সন্ধ্যা**: action=summary দিয়ে পূর্ণ দিনের রিপোর্ট দিন

### নিয়ম:
- প্রতিটি কাজ complete করার সময় description-এ ফলাফল/আউটকাম লিখুন
- একবারে একটি কাজ in_progress রাখুন
- মালিকের কাজ source=owner হিসেবে আসে, আপনার নিজের কাজ source=agent
- কাজ complete হলে মালিককে সংক্ষেপে ফলাফল জানান, তারপর পরবর্তী কাজে যান
- দিন শেষে সমস্ত completed items-এর সারাংশ দিন
`
