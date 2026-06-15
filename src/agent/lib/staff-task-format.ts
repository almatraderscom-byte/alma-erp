/**
 * Grouped Bangla formatting for staff tasks (Telegram Markdown).
 * Used by dispatch cards, get_staff_tasks, proposals.
 */

export type FormattableStaffTask = {
  id?: string
  title: string
  type?: string
  status?: string
  source?: string
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

export type RichDispatchOpts = {
  /** Staff member the owner just edited (merge_into_proposal). */
  changedStaff?: string
  /** Task IDs added in the latest merge call. */
  newTaskIds?: string[]
}

function staffSortKey(name: string): string {
  return name.toLowerCase()
}

function namesMatch(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.includes(y) || y.includes(x)
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
    lines.push('  _আগে পাঠানো/পেন্ডিং:_')
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

function formatStaffBlockRich(
  name: string,
  priorActive: FormattableStaffTask[],
  proposed: FormattableStaffTask[],
  opts?: RichDispatchOpts,
): string {
  const isChanged = opts?.changedStaff ? namesMatch(name, opts.changedStaff) : false
  const newIdSet = new Set(opts?.newTaskIds ?? [])

  const newTasks = proposed.filter((t) => t.id && newIdSet.has(t.id))
  const existingProposed = proposed.filter((t) => !t.id || !newIdSet.has(t.id))

  const priorCount = priorActive.length
  const newCount = newTasks.length
  const existingCount = existingProposed.length

  let header = `*${name}*`
  if (isChanged && newCount > 0) {
    header += priorCount
      ? ` — ${priorCount}টি আগে পাঠানো, ${newCount}টি নতুন যোগ`
      : ` — ${newCount}টি নতুন যোগ`
  } else if (priorCount > 0 && existingCount === 0 && newCount === 0) {
    header += ` — ${priorCount}টি আগে পাঠানো (আজ নতুন যোগ নেই)`
  } else if (priorCount > 0 && !isChanged) {
    header += ` — ${priorCount}টি আগে পাঠানো, ${existingCount}টি প্রস্তাবে (আপনি পরিবর্তন করেননি)`
  } else if (existingCount > 0) {
    header += ` — ${existingCount}টি প্রস্তাবে`
  } else {
    header += ' — (কোনো টাস্ক নেই)'
  }

  const lines: string[] = [header]

  if (priorActive.length) {
    lines.push('  _আগে পাঠানো/পেন্ডিং:_')
    for (const t of priorActive) {
      const tag = t.status === 'done' ? ' ✅' : ' 📤'
      lines.push(`  • ${t.title}${tag}`)
    }
  }

  if (newTasks.length) {
    lines.push('  _এই আপডেটে নতুন:_')
    for (const t of newTasks) lines.push(`  • ${t.title} ✨`)
  }

  if (existingProposed.length) {
    lines.push(
      isChanged ? '  _আগের প্রস্তাবে ছিল:_' : '  _প্রস্তাবে আছে (অনুমোদন অপেক্ষা):_',
    )
    for (const t of existingProposed) lines.push(`  • ${t.title}`)
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

/**
 * Dispatch approval card — shows prior sent + proposed layers per staff.
 * Staff the owner did NOT edit are labeled "আপনি পরিবর্তন করেননি".
 */
export function buildRichDispatchSummary(
  date: string,
  proposed: FormattableStaffTask[],
  priorActive: FormattableStaffTask[],
  opts?: RichDispatchOpts,
): string {
  const proposedByStaff = groupByStaff(proposed.map((t) => ({ ...t, status: 'proposed' })))
  const priorByStaff = groupByStaff(priorActive)

  const allNames = new Set([...proposedByStaff.keys(), ...priorByStaff.keys()])
  const names = [...allNames].sort((a, b) => staffSortKey(a).localeCompare(staffSortKey(b)))

  const blocks = names.map((name) =>
    formatStaffBlockRich(
      name,
      priorByStaff.get(name) ?? [],
      proposedByStaff.get(name) ?? [],
      opts,
    ),
  )

  const footer = opts?.changedStaff
    ? `\n\n_ℹ️ আপনি শুধু ${opts.changedStaff}-এর তালিকা আপডেট করেছেন। অন্য স্টাফের প্রস্তাব আগের মতো আছে — Approve করলে সব proposed টাস্ক যাবে।_`
    : ''

  return `📋 স্টাফ টাস্ক ডিসপ্যাচ — ${date}\n\n${blocks.join('\n\n')}${footer}`
}

/** Simple dispatch summary (proposed only) — legacy fallback. */
export function buildDispatchSummary(date: string, proposed: FormattableStaffTask[]): string {
  return formatTasksGroupedByStaff(
    proposed.map((t) => ({ ...t, status: t.status ?? 'proposed' })),
    { header: `📋 স্টাফ টাস্ক ডিসপ্যাচ — ${date}` },
  )
}

/** Short owner-facing note after merge_into_proposal. */
export function buildMergeOwnerFocusReply(
  changedStaff: string,
  newCount: number,
  priorActive: FormattableStaffTask[],
  allStaffNames: string[],
): string {
  const priorForChanged = priorActive.filter((t) => namesMatch(t.staff.name, changedStaff))
  const others = allStaffNames.filter((n) => !namesMatch(n, changedStaff))

  const lines: string[] = []
  if (newCount > 0) {
    lines.push(`✅ *${changedStaff}*-এর জন্য ${newCount}টি নতুন টাস্ক যোগ করেছি।`)
  }
  if (priorForChanged.length) {
    lines.push(`📤 ${changedStaff}-এর ${priorForChanged.length}টি আগের টাস্ক এখনো পাঠানো/পেন্ডিং আছে — সেগুলো নিচে দেখানো হয়েছে।`)
  }
  for (const other of others) {
    const prior = priorActive.filter((t) => namesMatch(t.staff.name, other))
    const priorNote = prior.length ? `${prior.length}টি আগে পাঠানো` : 'আগে পাঠানো কিছু নেই'
    lines.push(`ℹ️ *${other}*: ${priorNote} — আপনি এখন পরিবর্তন করেননি।`)
  }
  lines.push('\nনিচের approval card-এ সব স্টাফের প্রস্তাব আছে — শুধু আপনি যে অংশ বলেছেন সেটাই নতুন যোগ হয়েছে।')
  return lines.join('\n')
}
