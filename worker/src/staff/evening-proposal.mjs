/**
 * Evening Proposal + worker-side profile-based task generation.
 * Profiles live HERE (VPS) — read from agent_kv_settings, not Vercel-only code.
 */
import { dhakaTodayYmd } from '../salah/dhaka-date.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/** Default profiles — seeded when agent_kv_settings has none. */
export const DEFAULT_PROFILES = {
  'Mohammad Eyafi': {
    skills: ['ad_creative', 'product_content', 'product_photo', 'video_reel', 'listing_update', 'order_followup', 'customer_reply', 'page_management'],
    dailyTargetTasks: 8,
    notes: 'Handles all creative, content, social media, customer comms',
  },
  Mustahid: {
    skills: ['product_photo', 'video_reel', 'listing_update', 'office_task', 'page_management', 'content_support'],
    dailyTargetTasks: 6,
    notes: 'Office work, photography, video, page support — NO delivery/packaging/COD',
  },
}

const SKILL_ORDER_CONTENT = [
  'order_followup', 'video_reel', 'ad_creative', 'product_content', 'product_photo',
  'listing_update', 'page_management', 'customer_reply',
]
const SKILL_ORDER_OTHER = [
  'product_photo', 'video_reel', 'listing_update', 'page_management', 'content_support', 'office_task',
]

function dhakaDateStr(offset = 0) {
  const base = dhakaTodayYmd()
  if (offset === 0) return base
  const d = new Date(`${base}T12:00:00+06:00`)
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

async function callInternal(path) {
  const res = await fetch(`${APP_URL()}${path}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN()}` },
  })
  const text = await res.text()
  try { return JSON.parse(text) }
  catch { return { raw: text, ok: res.ok } }
}

/** Load staff_task_profiles from Supabase; seed defaults if missing. */
export async function loadStaffProfiles(supabase) {
  const { data, error } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', 'staff_task_profiles')
    .maybeSingle()

  if (error) console.warn('[evening-proposal] profile load error:', error.message)

  if (data?.value && typeof data.value === 'object' && Object.keys(data.value).length) {
    const merged = { ...DEFAULT_PROFILES, ...data.value }
    console.log('[evening-proposal] staff_task_profiles loaded:', Object.keys(merged).join(', '))
    return merged
  }

  console.log('[evening-proposal] seeding default staff_task_profiles')
  await supabase.from('agent_kv_settings').upsert({
    key: 'staff_task_profiles',
    value: DEFAULT_PROFILES,
    updated_at: new Date().toISOString(),
  })
  return { ...DEFAULT_PROFILES }
}

export function getProfileForStaff(profiles, staffName) {
  for (const [name, profile] of Object.entries(profiles)) {
    const n = staffName.toLowerCase()
    const key = name.toLowerCase()
    if (n.includes(key) || key.includes(n)) return profile
  }
  return null
}

function isContentStaff(staff) {
  return staff.role === 'content' || /eyafi/i.test(staff.name)
}

function staffHasSkill(profile, skill) {
  if (!profile) return true
  return profile.skills.includes(skill)
}

function productLabel(pick) {
  return pick.productRef || pick.name || 'পণ্য'
}

function makeTask(staff, type, title, detail, pick, source = 'rotation') {
  return {
    staffId: staff.id,
    staffName: staff.name,
    title,
    detail: detail ?? undefined,
    type,
    productRef: pick?.productRef ?? pick?.name ?? undefined,
    source,
  }
}

function buildSkillTask(staff, skill, picks, pendingOrders, profile) {
  if (!staffHasSkill(profile, skill)) return null
  const pick = picks[0]
  const pick2 = picks[1] ?? pick
  const label = pick ? productLabel(pick) : null

  switch (skill) {
    case 'video_reel':
      if (!pick) return null
      return makeTask(
        staff, 'video_reel',
        `${label} এর জন্য ৩০-সেকেন্ড ভিডিও রিল — family matching হাইলাইট করুন`,
        `FB/Insta Reels-এ পোস্ট করুন। ${pick.reasons?.[0] ?? 'বেস্টসেলার হাইলাইট'}`,
        pick,
      )
    case 'ad_creative':
      if (!pick) return null
      return makeTask(
        staff, 'ad_creative',
        `${label} — FB/Instagram অ্যাড ক্রিয়েটিভ (square 1080 + story 1080×1920)`,
        pick.reasons?.slice(0, 2).join('; ') ?? 'অ্যাড সেট আপ করুন',
        pick,
      )
    case 'product_content':
      if (!pick) return null
      return makeTask(
        staff, 'product_content',
        `${label} — ক্যাপশন + হ্যাশট্যাগ + পোস্ট কপি (Bangla)`,
        pick.reasons?.[0] ?? 'কন্টেন্ট তৈরি করুন',
        pick,
      )
    case 'product_photo':
      if (!pick2) return null
      return makeTask(
        staff, 'product_photo',
        `${productLabel(pick2)} — প্রোডাক্ট ফটো শুট (ফ্রন্ট, সাইড, ডিটেইল, lifestyle)`,
        `স্টক: ${pick2.stock ?? '?'}. ক্যাটালগে আপলোড করুন`,
        pick2,
      )
    case 'listing_update':
      if (!pick) return null
      return makeTask(
        staff, 'listing_update',
        `${label} — Daraz/FB shop লিস্টিং আপডেট (ছবি + বিবরণ + ভ্যারিয়েন্ট)`,
        pick.reasons?.[0] ?? 'লিস্টিং উন্নত করুন',
        pick,
      )
    case 'order_followup':
      if (!pendingOrders) return null
      return makeTask(
        staff, 'order_followup',
        `${pendingOrders}টি পেন্ডিং অর্ডার ফলো-আপ — কল/মেসেজ করে কনফার্ম করুন`,
        'কাস্টমার কনফার্ম বা ডেলিভারি আপডেট নিন',
        null,
        'pattern',
      )
    case 'page_management':
      return makeTask(
        staff, 'page_management',
        'Alma Lifestyle FB + Insta — কভার, pinned post, story scheduler চেক',
        'আনরিপ্লাইড কমেন্ট + story queue রিভিউ',
        null,
        'agent',
      )
    case 'customer_reply':
      return makeTask(
        staff, 'customer_reply',
        'Messenger + FB comment — সব unread রিপ্লাই দিন (Alma Lifestyle)',
        '২৪ ঘণ্টার মেসেজিং window মাথায় রাখুন',
        null,
        'agent',
      )
    case 'content_support':
      return makeTask(
        staff, 'content_support',
        'কন্টেন্ট শুট সাপোর্ট — প্রোডাক্ট সাজানো, লাইটিং, ব্যাকগ্রাউন্ড সেটআপ',
        'Eyafi ভাইয়ের শুটে সাহায্য করুন',
        null,
        'agent',
      )
    case 'office_task':
      return makeTask(
        staff, 'office_task',
        'অফিস/গোডাউন অর্গানাইজ — নতুন স্টক সাজানো, লেবেলিং চেক',
        'শোরুম + গোডাউন গুছিয়ে রাখুন',
        null,
        'agent',
      )
    case 'stock_check':
      if (!pick) return null
      return makeTask(
        staff, 'stock_check',
        `${label} — স্টক চেক ও রেকর্ড আপডেট`,
        `বর্তমান স্টক: ${pick.stock ?? '?'}`,
        pick,
      )
    default:
      return null
  }
}

/** Build profile-filtered tasks for one staff member (6–8 tasks). */
export function buildTasksForStaff(staff, profile, picks, carryForward, pendingOrders) {
  const tasks = []
  const targetCount = profile?.dailyTargetTasks ?? 6
  const usedTypes = new Set()

  for (const carried of carryForward.filter((t) => t.staff_id === staff.id || t.staffId === staff.id)) {
    const type = carried.type || 'misc'
    if (!staffHasSkill(profile, type)) continue
    tasks.push({
      staffId: staff.id,
      staffName: staff.name,
      title: `↩ ${carried.title} (গতকালের কাজ)`,
      detail: carried.detail ?? undefined,
      type,
      productRef: carried.product_ref ?? carried.productRef ?? undefined,
      source: 'pattern',
    })
    usedTypes.add(type)
  }

  const skillOrder = isContentStaff(staff) ? SKILL_ORDER_CONTENT : SKILL_ORDER_OTHER
  let pickIdx = 0

  for (const skill of skillOrder) {
    if (tasks.length >= targetCount) break
    if (usedTypes.has(skill)) continue
    const pickSlice = picks.slice(pickIdx, pickIdx + 2)
    if (!pickSlice.length && ['video_reel', 'ad_creative', 'product_content', 'product_photo', 'listing_update', 'stock_check'].includes(skill)) {
      continue
    }
    const task = buildSkillTask(staff, skill, pickSlice.length ? pickSlice : picks, pendingOrders, profile)
    if (task) {
      tasks.push(task)
      usedTypes.add(skill)
      if (['video_reel', 'product_photo', 'ad_creative', 'product_content', 'listing_update'].includes(skill)) {
        pickIdx = Math.min(pickIdx + 1, Math.max(0, picks.length - 1))
      }
    }
  }

  // Fill remaining slots cycling skills + picks
  let round = 0
  while (tasks.length < targetCount && round < 12) {
    const skill = skillOrder[round % skillOrder.length]
    const pick = picks[round % Math.max(1, picks.length)]
    if (!usedTypes.has(skill) || round >= skillOrder.length) {
      const task = buildSkillTask(staff, skill, [pick], pendingOrders, profile)
      if (task && !tasks.some((t) => t.type === task.type && t.productRef === task.productRef)) {
        tasks.push(task)
      }
    }
    round++
  }

  const carryCount = tasks.filter((t) => t.title.startsWith('↩')).length
  if (tasks.length > targetCount + carryCount) {
    const carries = tasks.filter((t) => t.title.startsWith('↩'))
    const rest = tasks.filter((t) => !t.title.startsWith('↩')).slice(0, targetCount)
    return [...carries, ...rest]
  }

  return tasks
}

function formatSummary(date, staffList, tasks, picks, carryCount, pendingOrders) {
  const byStaff = staffList.map((s) => {
    const sTasks = tasks.filter((t) => t.staffName === s.name)
    return `*${s.name}* (${sTasks.length}টি):\n${sTasks.map((t) => `  • ${t.title}`).join('\n')}`
  })
  const topLine = picks.slice(0, 3).map((p) => `  • ${p.name}: ${p.reasons?.[0] ?? ''}`).join('\n')
  let msg =
    `📋 *আজকের স্টাফ টাস্ক প্রস্তাব* — ${date}\n\n` +
    byStaff.join('\n\n') +
    (topLine ? `\n\n🔥 *বেস্টসেলার/ফোকাস পণ্য (৩০ দিন):*\n${topLine}` : '') +
    (pendingOrders > 0 ? `\n\n📦 পেন্ডিং অর্ডার: ${pendingOrders}টি` : '')
  if (carryCount > 0) msg += `\n\n⚠️ গতকালের ${carryCount}টি অসম্পূর্ণ কাজ যোগ করা হয়েছে।`
  return msg
}

/**
 * Worker-side proposal builder — profiles applied on VPS.
 * ERP rotation data fetched from Vercel API; task list built locally.
 */
export async function buildWorkerTaskProposal(supabase, targetDate) {
  const [{ data: staffRows, error: staffErr }, profiles, apiData] = await Promise.all([
    supabase.from('agent_staff').select('id, name, role, telegramChatId').eq('active', true).order('name'),
    loadStaffProfiles(supabase),
    callInternal(`/api/assistant/internal/staff-task-proposal?date=${targetDate}`),
  ])

  if (staffErr) throw new Error(`staff load: ${staffErr.message}`)
  const staffList = (staffRows ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    telegramChatId: s.telegramChatId,
  }))
  if (!staffList.length) return { success: false, error: 'কোনো active staff পাওয়া যায়নি' }

  const picks = apiData.rotationPicks ?? []
  const pendingOrders = apiData.pendingOrders ?? 0
  if (!picks.length && !apiData.success) {
    console.warn('[evening-proposal] API data fallback:', apiData.error || apiData.raw)
  }

  const yesterday = (() => {
    const d = new Date(`${targetDate}T12:00:00+06:00`)
    d.setDate(d.getDate() - 1)
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  })()

  const { data: carryRows } = await supabase
    .from('staff_tasks')
    .select('staff_id, title, detail, type, product_ref')
    .eq('proposed_for', yesterday)
    .in('status', ['sent', 'approved'])

  const allTasks = []
  for (const staff of staffList) {
    const profile = getProfileForStaff(profiles, staff.name)
    const staffTasks = buildTasksForStaff(staff, profile, picks, carryRows ?? [], pendingOrders)
    console.log(
      `[evening-proposal] ${staff.name}: profile target=${profile?.dailyTargetTasks ?? 6} ` +
      `skills=[${(profile?.skills ?? []).join(',')}] → ${staffTasks.length} tasks ` +
      `(video_reel=${staffTasks.filter((t) => t.type === 'video_reel').length}, ` +
      `stock=${staffTasks.filter((t) => t.type === 'stock_check').length})`,
    )
    allTasks.push(...staffTasks)
  }

  const summaryBangla = formatSummary(targetDate, staffList, allTasks, picks, (carryRows ?? []).length, pendingOrders)

  return {
    success: true,
    date: targetDate,
    staff: staffList,
    tasks: allTasks,
    rotationPicks: picks,
    carryForwardCount: (carryRows ?? []).length,
    pendingOrders,
    summaryBangla,
    profilesLoaded: Object.keys(profiles),
  }
}

/** Full proposal job — insert tasks + send approval card. */
export async function runTaskProposal(supabase, { targetOffsetDays = 0 } = {}) {
  const targetDate = dhakaDateStr(targetOffsetDays)
  const label = targetOffsetDays === 1 ? 'evening-proposal' : 'task-proposal'
  console.log(`[${label}] starting for ${targetDate} (worker profiles)...`)

  try {
    const proposal = await buildWorkerTaskProposal(supabase, targetDate)
    if (!proposal.success || !proposal.tasks?.length) {
      console.warn(`[${label}] no tasks:`, proposal.error)
      const { notify } = await import('../notify/index.mjs')
      await notify({
        tier: 1,
        title: label === 'evening-proposal' ? '🌙 আজ কোনো টাস্ক প্রস্তাব নেই' : 'টাস্ক প্রস্তাব',
        message: `${targetDate} — কোনো task তৈরি হয়নি।`,
        category: 'task',
      }).catch(() => {})
      return
    }

    const carryFrom = (() => {
      const d = new Date(`${targetDate}T12:00:00+06:00`)
      d.setDate(d.getDate() - 1)
      return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    })()

    await supabase
      .from('staff_tasks')
      .update({ status: 'carried' })
      .eq('proposed_for', carryFrom)
      .in('status', ['sent', 'approved'])

    await supabase.from('staff_tasks').delete().eq('proposed_for', targetDate).eq('status', 'proposed')

    const taskData = proposal.tasks.map((t) => ({
      id: crypto.randomUUID(),
      staff_id: t.staffId,
      title: t.title,
      detail: t.detail ?? null,
      type: t.type,
      product_ref: t.productRef ?? null,
      status: 'proposed',
      proposed_for: targetDate,
      source: t.source,
      created_at: new Date().toISOString(),
    }))

    await supabase.from('staff_tasks').insert(taskData)
    console.log(`[${label}] inserted ${taskData.length} proposed tasks for ${targetDate}`)

    const { data: insertedTasks } = await supabase
      .from('staff_tasks')
      .select('id')
      .eq('proposed_for', targetDate)
      .eq('status', 'proposed')

    const taskIds = insertedTasks?.map((t) => t.id) ?? []

    await supabase
      .from('agent_pending_actions')
      .update({ status: 'superseded', resolvedAt: new Date().toISOString() })
      .eq('type', 'dispatch_staff_tasks')
      .eq('status', 'pending')

    await supabase.from('agent_pending_actions').insert({
      id: crypto.randomUUID(),
      type: 'dispatch_staff_tasks',
      payload: { date: targetDate, taskIds },
      summary: targetOffsetDays === 1
        ? `🌙 *আগামীকাল (${targetDate}) স্টাফ টাস্ক*\n\n${proposal.summaryBangla}`
        : proposal.summaryBangla,
      costEstimate: 0,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })

    const { sendTelegramApprovalCard } = await import('../telegram/dispatcher.mjs')
    const { data: pendingAction } = await supabase
      .from('agent_pending_actions')
      .select('id')
      .eq('status', 'pending')
      .eq('type', 'dispatch_staff_tasks')
      .order('createdAt', { ascending: false })
      .limit(1)
      .single()

    if (!pendingAction?.id) {
      console.error(`[${label}] pending action not found — approval buttons will be missing`)
    }
    await sendTelegramApprovalCard({
      message: proposal.summaryBangla,
      pendingActionId: pendingAction?.id,
      approveLabel: '✅ সব Approve',
      editLabel: '✏️ সম্পাদনা',
      rejectLabel: '❌ বাতিল',
    })

    console.log(`[${label}] approval card sent for ${taskData.length} tasks`)
  } catch (err) {
    console.error(`[${label}] error:`, err.message, err.stack)
    throw err
  }
}

export async function runEveningProposal(supabase) {
  return runTaskProposal(supabase, { targetOffsetDays: 1 })
}
