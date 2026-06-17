/**
 * Phase F — inject Boss's active agent_todos into volatile prompt context.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { tomorrowYmdDhaka } from '@/agent/lib/owner-task-intake'

const BUSINESS_ID = 'ALMA_LIFESTYLE'

export const OWNER_TASK_REMINDER_RULES = `
## Boss-এর নিজের কাজ (owner todos — panel-এ "Boss-এর আজকের কাজ")
- সব active owner todo (source=owner, agent_todos) আপনি জানেন — নিচের তালিকা + list_owner_todos / manage_work_todos।
- Sir বললে "এটা কালকের/আজকের কাজে রাখো" → manage_work_todos action=add, source=owner, dueDate=আজ/কাল।
- Sir panel থেকে manually যোগ করলেও একই row — আপনি দেখতে ও মনে রাখবেন।
- **Active todo reminder (gentle, human):** due আজ এমন কাজ unfinished থাকলে প্রাকৃতিক মুহূর্তে (owner message, morning brief, একবার midday) জিজ্ঞেস করতে পারেন: "Sir, '[title]' টা কি হয়েছে?" — relevant হলে সাহায্য offer।
  - **সর্বোচ্চ একবার প্রতি todo প্রতি দিন** — guilt/lecture নয়। Sir "পরে/ব্যস্ত/থাক" বললে আজ আর চাপ দেবেন না (personal snooze rule)।
  - Sir done বললে বা panel-এ complete → সংক্ষিপ্ত acknowledge, আর remind নয়।
`

function dueDateRangeYmd(ymd: string) {
  return {
    start: new Date(`${ymd.slice(0, 10)}T00:00:00+06:00`),
    end: new Date(`${ymd.slice(0, 10)}T23:59:59.999+06:00`),
  }
}

export async function buildOwnerActiveTasksContextBlock(
  businessId = BUSINESS_ID,
): Promise<string> {
  const today = todayYmdDhaka()
  const tomorrow = tomorrowYmdDhaka(today)
  const todayRange = dueDateRangeYmd(today)
  const tomorrowRange = dueDateRangeYmd(tomorrow)

  const rows = await prisma.agentTodo.findMany({
    where: {
      businessId,
      source: 'owner',
      status: { notIn: ['completed', 'cancelled'] },
      OR: [
        { dueDate: { gte: todayRange.start, lte: todayRange.end } },
        { dueDate: { gte: tomorrowRange.start, lte: tomorrowRange.end } },
        { dueDate: null, createdAt: { gte: todayRange.start } },
      ],
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    take: 12,
    select: { title: true, status: true, dueDate: true, priority: true },
  })

  if (rows.length === 0) {
    return `${OWNER_TASK_REMINDER_RULES}\n\n## Boss-এর active tasks\n(আজ/কাল — কোনো open owner todo নেই)`
  }

  const lines = rows.map((r) => {
    const due = r.dueDate
      ? r.dueDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
      : 'today'
    const dueLabel = due === today ? 'আজ' : due === tomorrow ? 'কাল' : due
    return `- [${r.status}] ${r.title} (${dueLabel}${r.priority !== 'normal' ? ` · ${r.priority}` : ''})`
  })

  return `${OWNER_TASK_REMINDER_RULES}\n\n## Boss-এর active tasks (${rows.length})\n${lines.join('\n')}`
}
