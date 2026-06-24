/**
 * Grouped Bangla formatting for staff tasks (Telegram Markdown).
 * Used by dispatch cards, get_staff_tasks, proposals.
 */

/** Instruction appended to proposal builders — no extra LLM call; guides detail output. */
export const STAFF_TASK_DETAIL_INSTRUCTION =
  'প্রতিটা task-এর জন্য একটা `detail` লেখো — ২-৩ লাইন, খুব সহজ বাংলা, staff-এর level অনুযায়ী। ' +
  'কোন tool/template দিয়ে করবে স্পষ্ট বলো (Canva/CapCut/Website admin)। ধাপ ভেঙে দাও। জটিল শব্দ নয়।'

const TOOL_HINT_BY_TYPE: Record<string, string> = {
  video_reel: 'CapCut',
  ad_creative: 'Canva',
  product_content: 'Canva / FB',
  product_photo: 'ফোন ক্যামেরা',
  listing_update: 'Website admin / FB shop',
  order_followup: 'ERP + ফোন/মেসেঞ্জার',
  page_management: 'FB Page admin',
  customer_reply: 'Messenger',
  content_support: 'অফিস/শুট সেটআপ',
  office_task: 'অফিস',
  stock_check: 'ERP inventory',
  organic_marketing: 'Website admin',
  offer_idea: 'Canva / নোট',
  learning: 'CapCut / Canva',
  misc: 'ERP',
}

type DetailInput = {
  title: string
  type?: string
  productRef?: string | null
  detail?: string | null
}

function lineCount(text: string): number {
  return text.split(/\n/).filter((l) => l.trim()).length
}

function hasToolHint(text: string, tool: string): boolean {
  const lower = text.toLowerCase()
  return tool.split('/').some((part) => lower.includes(part.trim().toLowerCase()))
}

/** Ensure 2–3 line staff-friendly Bangla detail with explicit tool name. */
export function buildStaffFriendlyDetail(task: DetailInput): string {
  const type = task.type ?? 'misc'
  const tool = TOOL_HINT_BY_TYPE[type] ?? TOOL_HINT_BY_TYPE.misc
  const existing = (task.detail ?? '').trim()

  if (existing && lineCount(existing) >= 2 && lineCount(existing) <= 4 && hasToolHint(existing, tool)) {
    return existing.split('\n').slice(0, 4).join('\n').trim()
  }

  const product = task.productRef?.trim() || null
  const titleHint = task.title.replace(/^↩\s*|^🔄\s*গতকার থেকে বাকি:\s*|^📚\s*|^🎯\s*/u, '').trim()

  switch (type) {
    case 'order_followup':
      return [
        `${tool} খুলে Pending অর্ডার লিস্ট দেখুন।`,
        '১) কাস্টমারকে কল/মেসেজ — কনফার্ম বা ডেলিভারি আপডেট নিন।',
        '২) ERP-এ status আপডেট করুন।',
      ].join('\n')
    case 'video_reel':
      return [
        `${tool} দিয়ে ${product ?? titleHint} এর ১৫–৩০ সেকেন্ড রিল বানান।`,
        '১) প্রোডাক্ট clear দেখান  ২) নাম+দাম text দিন  ৩) Export করে proof পাঠান।',
      ].join('\n')
    case 'ad_creative':
      return [
        `${tool}-তে square (1080×1080) + story (1080×1920) অ্যাড বানান।`,
        `প্রোডাক্ট: ${product ?? titleHint}। শেষে PNG export করে owner-কে দিন।`,
      ].join('\n')
    case 'product_photo':
      return [
        `${tool} দিয়ে ৪ angle ছবি তুলুন (সামনে, পেছন, close-up, full)।`,
        product ? `SKU: ${product}।` : '',
        'Website admin-এ আপলোডের জন্য owner-কে পাঠান।',
      ].filter(Boolean).join('\n')
    case 'product_content':
      return [
        `${tool} দিয়ে FB পোস্ট caption (Bangla) লিখুন।`,
        `প্রোডাক্ট: ${product ?? titleHint} — feature, দাম, CTA (DM করুন)।`,
      ].join('\n')
    case 'listing_update':
      return [
        `${tool} খুলে listing আপডেট করুন।`,
        `ছবি/দাম/বর্ণনা চেক — ${product ?? titleHint}।`,
      ].join('\n')
    case 'stock_check':
      return [
        `${tool} inventory খুলে স্টক মিলান।`,
        product ? `SKU ${product} — physical count vs ERP লিখে owner-কে জানান।` : 'Physical count vs ERP নোট করুন।',
      ].join('\n')
    case 'page_management':
      return [
        'FB Page admin + Insta app খুলুন।',
        '১) Unreplied comments reply  ২) Story/pinned post চেক  ৩) Proof screenshot পাঠান।',
      ].join('\n')
    case 'customer_reply':
      return [
        `${tool} inbox — সব unread reply দিন (Alma Lifestyle + Online Shop)।`,
        'Product query → দাম+availability। Order query → ERP status দেখে জানান।',
      ].join('\n')
    default:
      if (existing && lineCount(existing) >= 2) {
        const lines = existing.split('\n').slice(0, 3)
        if (!hasToolHint(existing, tool) && tool) lines.push(`টুল: ${tool}`)
        return lines.join('\n').trim()
      }
      return [
        `${tool} ব্যবহার করে কাজটি করুন।`,
        titleHint.slice(0, 120),
        'শেষে Done চাপুন + proof পাঠান।',
      ].join('\n')
  }
}

/**
 * Make a Gemini/owner-written explanation SURVIVE the dispatch-time regeneration in
 * staff-dispatch-sync.ts, which calls `buildStaffFriendlyDetail` on every task right
 * before sending. That preserves an existing detail only when it is 2–4 non-empty
 * lines AND already names the task's tool. So we normalize the explanation to ≤4
 * lines and, if the tool keyword is missing, append a "টুল: …" line — guaranteeing
 * the explanation rides with the task instead of being overwritten by the template.
 *
 * Returns '' when the explanation is empty so the caller can fall back to the
 * template (buildStaffFriendlyDetail) instead of persisting a blank detail.
 */
export function makeDispatchSafeDetail(
  task: { title: string; type?: string; productRef?: string | null },
  explanation: string,
): string {
  const type = task.type ?? 'misc'
  const tool = TOOL_HINT_BY_TYPE[type] ?? TOOL_HINT_BY_TYPE.misc
  let lines = explanation
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
  if (!lines.length) return ''
  if (!hasToolHint(lines.join('\n'), tool)) {
    lines = [...lines.slice(0, 3), `টুল: ${tool}`]
  }
  // buildStaffFriendlyDetail only preserves an existing detail when it has ≥2 lines;
  // guarantee that floor so a thin one-line explanation isn't overwritten at dispatch.
  if (lines.length < 2) lines.push(`টুল: ${tool}`)
  return lines.join('\n')
}

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
