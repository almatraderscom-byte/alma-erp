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
- Boss বললে "এটা কালকের/আজকের কাজে রাখো" → manage_work_todos action=add, source=owner, dueDate=আজ/কাল।
- Boss panel থেকে manually যোগ করলেও একই row — আপনি দেখতে ও মনে রাখবেন।
- **Active todo reminder (gentle, human):** due আজ এমন কাজ unfinished থাকলে প্রাকৃতিক মুহূর্তে (owner message, morning brief, একবার midday) জিজ্ঞেস করতে পারেন: "Boss, '[title]' টা কি হয়েছে?" — relevant হলে সাহায্য offer।
  - **সর্বোচ্চ একবার প্রতি todo প্রতি দিন** — guilt/lecture নয়। Boss "পরে/ব্যস্ত/থাক" বললে আজ আর চাপ দেবেন না (personal snooze rule)।
  - Boss done বললে বা panel-এ complete → সংক্ষিপ্ত acknowledge, আর remind নয়।
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
    return `## Boss-এর active tasks\n(আজ/কাল — কোনো open owner todo নেই)`
  }

  const lines = rows.map((r) => {
    const due = r.dueDate
      ? r.dueDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
      : 'today'
    const dueLabel = due === today ? 'আজ' : due === tomorrow ? 'কাল' : due
    return `- [${r.status}] ${r.title} (${dueLabel}${r.priority !== 'normal' ? ` · ${r.priority}` : ''})`
  })

  return `## Boss-এর active tasks (${rows.length})\n${lines.join('\n')}`
}

// ────────────────────────────────────────────────────────────────────────────
// Phase A — inject ACTIVE STAFF tasks into the head agent's per-turn context.
// Until now the head (Claude) only saw owner todos; active staff tasks lived only
// in the office-supervisor cron + DB, so the conversational head was blind to them
// ("কী দিয়েছিলাম Mustahid-কে?" → had to guess from chat). This makes the head an
// office manager: it always knows the durable office state. READ-ONLY awareness —
// the head still uses staff tools to assign / follow-up / verify / escalate.
// ────────────────────────────────────────────────────────────────────────────

// Mirrors office-supervisor ACTIVE_STATUSES; plus tasks flagged for owner review
// (escalated / needs-owner) even if their status moved on.
const STAFF_ACTIVE_STATUSES = ['sent', 'approved', 'carried', 'awaiting_proof'] as const

export const STAFF_TASK_AWARENESS_RULES = `
## 🏢 অফিস ম্যানেজার ভূমিকা (active staff কাজ — আপনি জানেন)
- নিচের তালিকা durable DB থেকে, সবসময় up-to-date। staff/কাজ নিয়ে প্রশ্নে এখান থেকেই উত্তর দিন — অপ্রয়োজনে get_staff_tasks ডাকবেন না (নতুন/আরও ডিটেইল লাগলে ডাকুন)।
- নতুন কাজ দিতে prepare_staff_task_proposal; ফলো-আপ/আপডেট/QC/escalation staff tools দিয়ে — এই block শুধু awareness, এখান থেকে কিছু লেখা হয় না।
- চিহ্ন: ⏰ = deadline, ⚠️ = আপনার রিভিউ দরকার (escalated/needs-owner), ⏳ = আপডেট চাওয়া হয়েছে কিন্তু staff এখনো দেয়নি।`

function staffDueLabel(due: Date | null, today: string, tomorrow: string): string {
  if (!due) return ''
  const ymd = due.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  if (ymd < today) return ' ⏰ overdue'
  if (ymd === today) return ' ⏰ আজ'
  if (ymd === tomorrow) return ' ⏰ কাল'
  return ` ⏰ ${ymd}`
}

export async function buildStaffActiveTasksContextBlock(
  businessId = BUSINESS_ID,
): Promise<string> {
  const today = todayYmdDhaka()
  const tomorrow = tomorrowYmdDhaka(today)

  const rows = await prisma.agentStaffTask.findMany({
    where: {
      businessId,
      OR: [
        { status: { in: [...STAFF_ACTIVE_STATUSES] } },
        { supervisorNeedsOwner: true, status: { notIn: ['done', 'cancelled', 'rejected'] } },
        { escalatedAt: { not: null }, status: { notIn: ['done', 'cancelled', 'rejected'] } },
      ],
    },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    take: 30,
    select: {
      title: true,
      status: true,
      verificationStatus: true,
      dueAt: true,
      updateRequestedAt: true,
      lastStaffUpdateAt: true,
      escalatedAt: true,
      supervisorNeedsOwner: true,
      staff: { select: { name: true } },
    },
  })

  if (rows.length === 0) {
    return `(এখন কোনো active staff কাজ নেই)`
  }

  // Group by staff name, preserving the dueAt/createdAt ordering within each group.
  const byStaff = new Map<string, string[]>()
  for (const r of rows) {
    const name = r.staff?.name ?? 'অজানা'
    const flags: string[] = []
    flags.push(staffDueLabel(r.dueAt, today, tomorrow))
    const needsOwner =
      r.supervisorNeedsOwner || (r.escalatedAt != null && r.status !== 'done')
    if (needsOwner) flags.push(' ⚠️ রিভিউ দরকার')
    const updatePending =
      r.updateRequestedAt != null &&
      (r.lastStaffUpdateAt == null || r.lastStaffUpdateAt < r.updateRequestedAt)
    if (updatePending) flags.push(' ⏳ আপডেট pending')
    const verif =
      r.verificationStatus && r.verificationStatus !== 'not_required'
        ? ` · ${r.verificationStatus}`
        : ''
    const line = `- [${r.status}${verif}] ${r.title}${flags.join('')}`
    const list = byStaff.get(name) ?? []
    list.push(line)
    byStaff.set(name, list)
  }

  const sections = Array.from(byStaff.entries()).map(
    ([name, lines]) => `### ${name} (${lines.length})\n${lines.join('\n')}`,
  )

  return `## অফিসের active staff কাজ (${rows.length})\n${sections.join('\n\n')}`
}
