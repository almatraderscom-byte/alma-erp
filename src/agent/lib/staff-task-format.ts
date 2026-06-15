/**
 * Grouped Bangla formatting for staff tasks (Telegram Markdown).
 * Used by dispatch cards, get_staff_tasks, proposals.
 */

export type StaffDispatchBreakdown = {
  date: string
  proposedToDispatch: number
  alreadySentPending: number
  alreadyDone: number
  perStaff: Array<{
    name: string
    sentPending: number
    done: number
    proposed: number
    approved: number
    sentPendingTitles: string[]
    proposedTitles: string[]
  }>
}

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
  const sentPending = staffTasks.filter((t) => (t.status ?? '') === 'sent')
  const done = staffTasks.filter((t) => (t.status ?? '') === 'done')
  const approved = staffTasks.filter((t) => (t.status ?? '') === 'approved')
  const proposed = staffTasks.filter((t) => (t.status ?? 'proposed') === 'proposed')
  const other = staffTasks.filter(
    (t) => !['sent', 'done', 'approved', 'proposed'].includes(t.status ?? ''),
  )

  const lines: string[] = [`*${name}* (${staffTasks.length}টি)`]

  if (sentPending.length) {
    lines.push('  _পাঠানো (Done হয়নি):_')
    for (const t of sentPending) lines.push(`  • ${t.title} 📤`)
  }
  if (done.length) {
    lines.push('  _সম্পন্ন:_')
    for (const t of done) lines.push(`  • ${t.title} ✅`)
  }
  if (approved.length) {
    lines.push('  _অনুমোদিত (এখনো পাঠানো হয়নি):_')
    for (const t of approved) lines.push(`  • ${t.title}`)
  }
  if (proposed.length) {
    lines.push('  _অনুমোদনের অপেক্ষায়:_')
    for (const t of proposed) lines.push(`  • ${t.title}`)
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

  const priorSent = priorActive.filter((t) => (t.status ?? '') === 'sent')
  const priorDone = priorActive.filter((t) => (t.status ?? '') === 'done')
  const priorCount = priorSent.length
  const newCount = newTasks.length
  const existingCount = existingProposed.length

  let header = `*${name}*`
  if (isChanged && newCount > 0) {
    header += priorSent.length
      ? ` — ${priorSent.length}টি আগে পাঠানো (Done হয়নি), ${newCount}টি নতুন যোগ`
      : ` — ${newCount}টি নতুন যোগ`
  } else if (priorSent.length > 0 && existingCount === 0 && newCount === 0) {
    header += ` — ${priorSent.length}টি পাঠানো (Done হয়নি), নতুন যোগ নেই`
  } else if (priorSent.length > 0 && !isChanged) {
    header += ` — ${priorSent.length}টি পাঠানো (Done হয়নি), ${existingCount}টি প্রস্তাবে (আপনি পরিবর্তন করেননি)`
  } else if (existingCount > 0) {
    header += ` — ${existingCount}টি প্রস্তাবে`
  } else {
    header += ' — (কোনো টাস্ক নেই)'
  }

  const lines: string[] = [header]

  if (priorSent.length) {
    lines.push('  _আগে পাঠানো (Done হয়নি):_')
    for (const t of priorSent) lines.push(`  • ${t.title} 📤`)
  }
  if (priorDone.length) {
    lines.push('  _সম্পন্ন:_')
    for (const t of priorDone) lines.push(`  • ${t.title} ✅`)
  }

  if (newTasks.length) {
    lines.push('  _এই আপডেটে নতুন (Approve হলে যাবে):_')
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

  const proposedCount = proposed.length
  const footer = opts?.changedStaff
    ? `\n\n_ℹ️ আপনি শুধু ${opts.changedStaff} আপডেট করেছেন। Approve করলে শুধু ${proposedCount}টি proposed টাস্ক পাঠাবে — আগে পাঠানো টাস্ক আবার যাবে না, তবে স্টাফের আপডেটেড লিস্টে সেগুলোও থাকবে।_`
    : `\n\n_ℹ️ Approve করলে ${proposedCount}টি proposed টাস্ক পাঠাবে। আগে পাঠানো (Done হয়নি) টাস্ক আলাদা — সেগুলো সম্পন্ন নয় বলে ধরবেন না।_`

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
  const priorForChanged = priorActive.filter(
    (t) => namesMatch(t.staff.name, changedStaff) && (t.status ?? '') === 'sent',
  )
  const others = allStaffNames.filter((n) => !namesMatch(n, changedStaff))

  const lines: string[] = []
  if (newCount > 0) {
    lines.push(`✅ *${changedStaff}*-এর জন্য ${newCount}টি নতুন টাস্ক যোগ করেছি।`)
  }
  if (priorForChanged.length) {
    lines.push(
      `📤 ${changedStaff}-এর ${priorForChanged.length}টি আগের টাস্ক এখনো পাঠানো আছে (Done হয়নি) — Approve হলে নতুনের সাথে আপডেটেড লিস্ট যাবে।`,
    )
  }
  for (const other of others) {
    const prior = priorActive.filter(
      (t) => namesMatch(t.staff.name, other) && (t.status ?? '') === 'sent',
    )
    const priorNote = prior.length
      ? `${prior.length}টি পাঠানো (Done হয়নি)`
      : 'আগে পাঠানো কিছু নেই'
    lines.push(`ℹ️ *${other}*: ${priorNote} — আপনি এখন পরিবর্তন করেননি।`)
  }
  lines.push('\nনিচের approval card-এ proposed টাস্ক আছে — আগে পাঠানো টাস্ক "সম্পন্ন" নয়।')
  return lines.join('\n')
}

/** Owner-facing summary after approve_pending_dispatch. */
export function buildApproveResultBangla(
  breakdown: StaffDispatchBreakdown,
  dispatchedCount: number,
): string {
  const lines: string[] = [
    `✅ Approve হয়েছে — ${dispatchedCount}টি নতুন টাস্ক dispatch queue-তে।`,
  ]
  if (breakdown.alreadySentPending > 0) {
    lines.push(
      `📤 ${breakdown.alreadySentPending}টি আগে পাঠানো টাস্ক এখনো Done হয়নি — সেগুলো সম্পন্ন নয়, শুধু স্টাফের কাছে আছে।`,
    )
  }
  for (const s of breakdown.perStaff) {
    if (s.proposed > 0 || s.sentPending > 0) {
      const parts: string[] = []
      if (s.sentPending) parts.push(`${s.sentPending}টি আগে পাঠানো`)
      if (s.proposed) parts.push(`${s.proposed}টি নতুন পাঠাবে`)
      lines.push(`• *${s.name}*: ${parts.join(' + ')} = আজ মোট ${s.sentPending + s.proposed}টি সক্রিয়`)
    }
  }
  lines.push('\nget_dispatch_status দিয়ে verify করুন — "পাঠানো হয়েছে" বলার আগে।')
  return lines.join('\n')
}
