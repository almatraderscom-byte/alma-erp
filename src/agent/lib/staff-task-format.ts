/**
 * Grouped Bangla formatting for staff tasks (Telegram Markdown).
 * Used by dispatch cards, get_staff_tasks, proposals.
 */

export type FormattableStaffTask = {
  id?: string
  title: string
  type?: string
  status?: string
  staff: { name: string }
}

const STATUS_BN: Record<string, string> = {
  proposed: 'প্রস্তাবিত',
  approved: 'অনুমোদিত',
  sent: 'পাঠানো',
  done: 'সম্পন্ন',
  carried: 'ক্যারি ফরওয়ার্ড',
  cancelled: 'বাতিল',
}

function staffSortKey(name: string): string {
  return name.toLowerCase()
}

function groupByStaff(tasks: FormattableStaffTask[]): Map<string, FormattableStaffTask[]> {
  const map = new Map<string, FormattableStaffTask[]>()
  for (const t of tasks) {
    const name = t.staff.name
    map.set(name, [...(map.get(name) ?? []), t])
  }
  return map
}

function formatStaffBlock(name: string, staffTasks: FormattableStaffTask[]): string {
  const sentLike = staffTasks.filter((t) => ['sent', 'done', 'approved'].includes(t.status ?? ''))
  const proposed = staffTasks.filter((t) => (t.status ?? 'proposed') === 'proposed')
  const other = staffTasks.filter(
    (t) => !['sent', 'done', 'approved', 'proposed'].includes(t.status ?? ''),
  )

  const lines: string[] = [`*${name}* (${staffTasks.length}টি)`]

  if (sentLike.length) {
    lines.push('  _ইতিমধ্যে পাঠানো/চলমান:_')
    for (const t of sentLike) {
      const tag = t.status === 'done' ? ' ✅' : t.status === 'sent' ? ' 📤' : ''
      lines.push(`  • ${t.title}${tag}`)
    }
  }
  if (proposed.length) {
    lines.push('  _অনুমোদনের অপেক্ষায়:_')
    for (const t of proposed) {
      lines.push(`  • ${t.title}`)
    }
  }
  for (const t of other) {
    const label = STATUS_BN[t.status ?? ''] ?? t.status
    lines.push(`  • ${t.title} (${label})`)
  }

  return lines.join('\n')
}

/** Grouped summary — one bold staff header per person, tasks indented below. */
export function formatTasksGroupedByStaff(
  tasks: FormattableStaffTask[],
  opts?: { header?: string },
): string {
  if (!tasks.length) return opts?.header ? `${opts.header}\n\n(কোনো টাস্ক নেই)` : '(কোনো টাস্ক নেই)'

  const byStaff = groupByStaff(tasks)
  const names = [...byStaff.keys()].sort((a, b) => staffSortKey(a).localeCompare(staffSortKey(b)))
  const blocks = names.map((name) => formatStaffBlock(name, byStaff.get(name)!))
  const header = opts?.header ?? '📋 স্টাফ টাস্ক'
  return `${header}\n\n${blocks.join('\n\n')}`
}

/** Dispatch approval card — proposed tasks only, grouped by staff. */
export function buildDispatchSummary(date: string, proposed: FormattableStaffTask[]): string {
  return formatTasksGroupedByStaff(
    proposed.map((t) => ({ ...t, status: t.status ?? 'proposed' })),
    { header: `📋 স্টাফ টাস্ক ডিসপ্যাচ — ${date}` },
  )
}
