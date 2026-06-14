/**
 * Evening Proposal + worker-side profile-based task generation.
 * Profiles live HERE (VPS) — read from agent_kv_settings, not Vercel-only code.
 */
import { dhakaTodayYmd } from '../salah/dhaka-date.mjs'
import { formatDhakaDateLabel } from './bn-format.mjs'
import { fetchOwnerDecisions } from '../memory/owner-decisions.mjs'

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

/**
 * Daily learning curriculum — one skill-building task per staff per day.
 * Rotates through the list so they progressively build expertise.
 */
export const LEARNING_CURRICULUM = {
  Mustahid: [
    { title: 'CapCut শেখা: একটি প্রোডাক্ট ভিডিওতে text + transition যোগ করুন', detail: 'আজকের যেকোনো প্রোডাক্ট দিয়ে ১৫-৩০ সেকেন্ড রিল বানিয়ে practice করুন। শেষে owner কে পাঠান।' },
    { title: 'প্রোডাক্ট ডিজাইন বেসিক: Canva-তে একটি প্রোডাক্ট পোস্টার বানান', detail: 'ব্র্যান্ড কালার + প্রাইস + অফার সহ। ১টা ড্রাফট তৈরি করুন।' },
    { title: 'পেজ ম্যানেজমেন্ট শেখা: FB Insights দেখে কোন পোস্ট ভালো চলছে নোট করুন', detail: 'Reach, engagement বুঝে ৩টা observation লিখুন।' },
    { title: 'প্রোডাক্ট রিসার্চ: প্রতিযোগীদের ৩টা বেস্টসেলিং প্রোডাক্ট খুঁজে দাম তুলনা করুন', detail: 'কী কারণে তারা ভালো করছে — ২ লাইনে লিখুন।' },
    { title: 'কাস্টমার সাইকোলজি: গত সপ্তাহের ৫টা অর্ডার দেখে কোন প্রোডাক্ট কেন বিক্রি হলো বুঝুন', detail: 'প্যাটার্ন নোট করুন — owner কে রিপোর্ট দিন।' },
    { title: 'ফটোগ্রাফি শেখা: lighting + angle নিয়ে একই প্রোডাক্টের ৩ রকম ছবি তুলুন', detail: 'কোনটা সবচেয়ে ভালো — owner এর মতামত নিন।' },
    { title: 'বিজনেস বেসিক: profit margin কীভাবে হিসাব হয় শিখুন', detail: 'একটা প্রোডাক্টের cost, sell price, margin বের করুন।' },
  ],
  'Mohammad Eyafi': [
    { title: 'অ্যাড অপটিমাইজেশন: গত ক্যাম্পেইনের CTR/CPC দেখে কী উন্নতি করা যায় লিখুন', detail: '২টা actionable improvement।' },
    { title: 'কন্টেন্ট স্ট্র্যাটেজি: আগামী সপ্তাহের ৭ দিনের পোস্ট আইডিয়া বানান', detail: 'প্রতিদিনের theme ঠিক করুন।' },
    { title: 'অ্যাডভান্সড CapCut: trending transition + sound দিয়ে একটি রিল', detail: 'বর্তমান trend ফলো করে বানান।' },
    { title: 'কাস্টমার রিটেনশন: repeat customer দের জন্য একটা অফার আইডিয়া দিন', detail: 'কীভাবে আবার কিনতে আনা যায়।' },
    { title: 'কম্পিটিটর অ্যানালাইসিস: ৩টা প্রতিযোগী পেজের কৌশল নোট করুন', detail: 'আমরা কী শিখতে পারি।' },
  ],
}

export function getLearningTaskForStaff(staffName, dayIndex) {
  let list = null
  for (const [name, curriculum] of Object.entries(LEARNING_CURRICULUM)) {
    const n = staffName.toLowerCase()
    const key = name.toLowerCase()
    if (n.includes(key) || key.includes(n)) { list = curriculum; break }
  }
  if (!list || !list.length) return null
  const item = list[dayIndex % list.length]
  return item
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
    const rawTitle = String(carried.title ?? '').replace(/^↩\s*/, '')
    const title = rawTitle.startsWith('🔄')
      ? rawTitle
      : `🔄 গতকাল থেকে বাকি: ${rawTitle}`
    tasks.push({
      staffId: staff.id,
      staffName: staff.name,
      title,
      detail: carried.detail ?? undefined,
      type,
      productRef: carried.product_ref ?? carried.productRef ?? undefined,
      source: carried.source === 'carry_forward' ? 'carry_forward' : 'pattern',
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

  const carryCount = tasks.filter((t) => t.title.startsWith('🔄')).length
  let result
  if (tasks.length > targetCount + carryCount) {
    const carries = tasks.filter((t) => t.title.startsWith('🔄'))
    const rest = tasks.filter((t) => !t.title.startsWith('🔄')).slice(0, targetCount)
    result = [...carries, ...rest]
  } else {
    result = tasks
  }

  // Add one daily learning task (rotates through curriculum) — always last
  const dayIndex = Math.floor(Date.now() / 86_400_000)
  const learning = getLearningTaskForStaff(staff.name, dayIndex)
  if (learning) {
    result.push(
      makeTask(
        staff,
        'learning',
        `📚 ${learning.title}`,
        learning.detail,
        null,
        'curriculum',
      ),
    )
  }

  return result
}

function staffMatches(staffName, key) {
  const n = String(staffName).toLowerCase()
  const k = String(key).toLowerCase()
  return n.includes(k) || k.includes(n)
}

function analyzeOwnerDecisions(decisions) {
  const hints = {
    boostVideoStaff: new Set(),
    skipTypes: [],
    vetoAdProducts: [],
  }
  for (const m of decisions ?? []) {
    const text = (m.content || '').toLowerCase()
    if (/mustahid/.test(text) && /(video|ভিডিও|রিল|capcut)/.test(text) && /(বেশি|more|extra|বাড়)/.test(text)) {
      hints.boostVideoStaff.add('mustahid')
    }
    if (/eyafi/.test(text) && /(customer|chat|মেসেজ|messenger)/.test(text) && /(না|no|skip|দিও না|avoid)/.test(text)) {
      hints.skipTypes.push({ staffPattern: 'eyafi', types: ['customer_reply'] })
    }
    if (/ad boost/.test(text) && /(না|no|avoid|করো না)/.test(text)) {
      const prod = text.match(/(fm[-\w\d]+)/i)?.[1]
      if (prod) hints.vetoAdProducts.push(prod.toLowerCase())
    }
  }
  return hints
}

function adjustTasksForOwnerDecisions(staff, tasks, hints) {
  let out = [...tasks]
  const notes = []
  const name = staff.name

  if ([...hints.boostVideoStaff].some((k) => staffMatches(name, k))) {
    const videoCount = out.filter((t) => t.type === 'video_reel').length
    if (videoCount < 2) {
      const photoIdx = out.findIndex((t) => t.type === 'product_photo' && !t.title.startsWith('🔄'))
      if (photoIdx >= 0) {
        const t = out[photoIdx]
        out[photoIdx] = {
          ...t,
          type: 'video_reel',
          title: t.title.replace(/ফটো|photo/gi, 'ভিডিও রিল'),
          detail: `${t.detail || ''} [Owner directive: video focus]`.trim(),
          source: 'owner_decision',
        }
      }
    }
    notes.push(`গত নির্দেশ অনুযায়ী ${name} এর video task বাড়ানো হয়েছে`)
  }

  for (const skip of hints.skipTypes) {
    if (staffMatches(name, skip.staffPattern)) {
      const before = out.length
      out = out.filter((t) => !skip.types.includes(t.type))
      if (out.length < before) notes.push(`${name}: ${skip.types.join(', ')} বাদ (owner directive)`)
    }
  }

  if (hints.vetoAdProducts.length) {
    out = out.filter((t) => {
      if (t.type !== 'ad_creative') return true
      const ref = `${t.productRef || ''} ${t.title || ''}`.toLowerCase()
      return !hints.vetoAdProducts.some((p) => ref.includes(p))
    })
  }

  return { tasks: out, note: notes.length ? notes.join('; ') : null }
}

function formatStaffTaskBlock(staffName, staffTasks) {
  const carries = staffTasks.filter((t) => t.title.startsWith('🔄'))
  const fresh = staffTasks.filter((t) => !t.title.startsWith('🔄'))
  const lines = [
    ...carries.map((t) => `  • ${t.title}`),
    ...fresh.map((t) => `  • ${t.title}`),
  ]
  return `*${staffName}* (${staffTasks.length}টি):\n${lines.join('\n')}`
}

function formatSummary(date, staffList, tasks, picks, carryCount, pendingOrders) {
  const dateLabel = formatDhakaDateLabel(date)
  const byStaff = staffList.map((s) => {
    const sTasks = tasks.filter((t) => t.staffName === s.name)
    return formatStaffTaskBlock(s.name, sTasks)
  })
  const topLine = picks.slice(0, 3).map((p) => `  • ${p.name}: ${p.reasons?.[0] ?? ''}`).join('\n')
  let msg =
    `🌙 *আগামীকালের (${dateLabel}) টাস্ক প্রস্তাব:*\n\n` +
    byStaff.join('\n\n') +
    (topLine ? `\n\n🔥 *বেস্টসেলার/ফোকাস পণ্য (৩০ দিন):*\n${topLine}` : '') +
    (pendingOrders > 0 ? `\n\n📦 পেন্ডিং অর্ডার: ${pendingOrders}টি` : '')
  if (carryCount > 0) msg += `\n\n🔄 গতকালের ${carryCount}টি অসম্পূর্ণ কাজ প্রথমে যোগ করা হয়েছে।`
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

  const { data: nightCarry } = await supabase
    .from('staff_tasks')
    .select('staff_id, title, detail, type, product_ref, source')
    .eq('proposed_for', targetDate)
    .eq('source', 'carry_forward')

  let carryRows = nightCarry ?? []
  if (!carryRows.length) {
    const { data: yesterdayCarry } = await supabase
      .from('staff_tasks')
      .select('staff_id, title, detail, type, product_ref, source')
      .eq('proposed_for', yesterday)
      .in('status', ['sent', 'approved'])
    carryRows = yesterdayCarry ?? []
  }

  const allTasks = []
  const ownerDecisions = await fetchOwnerDecisions()
  const decisionHints = analyzeOwnerDecisions(ownerDecisions)
  const decisionNotes = []

  for (const staff of staffList) {
    const profile = getProfileForStaff(profiles, staff.name)
    let staffTasks = buildTasksForStaff(staff, profile, picks, carryRows ?? [], pendingOrders)
    const adjusted = adjustTasksForOwnerDecisions(staff, staffTasks, decisionHints)
    staffTasks = adjusted.tasks
    if (adjusted.note) decisionNotes.push(adjusted.note)
    console.log(
      `[evening-proposal] ${staff.name}: profile target=${profile?.dailyTargetTasks ?? 6} ` +
      `skills=[${(profile?.skills ?? []).join(',')}] → ${staffTasks.length} tasks ` +
      `(video_reel=${staffTasks.filter((t) => t.type === 'video_reel').length}, ` +
      `stock=${staffTasks.filter((t) => t.type === 'stock_check').length})`,
    )
    allTasks.push(...staffTasks)
  }

  let summaryBangla = formatSummary(targetDate, staffList, allTasks, picks, (carryRows ?? []).length, pendingOrders)
  if (decisionNotes.length) {
    summaryBangla += `\n\n📝 *গত নির্দেশ অনুযায়ী:* ${decisionNotes.join('; ')}`
  } else if (ownerDecisions.length) {
    summaryBangla += `\n\n📝 ${ownerDecisions.length}টি owner decision memory পড়া হয়েছে।`
  }

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
    ownerDecisionCount: ownerDecisions.length,
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

    const { error: insertErr } = await supabase.from('staff_tasks').insert(taskData)
    if (insertErr) throw new Error(`task insert: ${insertErr.message}`)
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
        ? `🌙 *আগামীকালের (${formatDhakaDateLabel(targetDate)}) স্টাফ টাস্ক*\n\n${proposal.summaryBangla}`
        : proposal.summaryBangla,
      costEstimate: 0,
      status: 'pending',
    })

    const { sendTelegramApprovalCard, buildStaffProposalKeyboard, getDispatcherBot } = await import('../telegram/dispatcher.mjs')
    const { notify } = await import('../notify/index.mjs')
    const { sendMarkdownSafe } = await import('../telegram/markdown-safe.mjs')

    const { data: pendingAction } = await supabase
      .from('agent_pending_actions')
      .select('id')
      .eq('status', 'pending')
      .eq('type', 'dispatch_staff_tasks')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!pendingAction?.id) {
      console.error(`[${label}] pending action not found — approval buttons will be missing`)
    }

    let cardResult = await sendTelegramApprovalCard({
      message: proposal.summaryBangla,
      pendingActionId: pendingAction?.id,
      proposalDate: targetDate,
      approveLabel: '✅ সব Approve',
      rejectLabel: '❌ বাতিল',
    })

    // Self-verify: pending action row + card with buttons both present
    const { data: paCheck } = await supabase
      .from('agent_pending_actions')
      .select('id')
      .eq('type', 'dispatch_staff_tasks')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)

    let cardSent = cardResult?.cardSent ?? false
    if (!cardSent || !paCheck?.length) {
      console.warn(`[${label}] self-verify failed (card=${cardSent}, pending=${paCheck?.length ?? 0}) — retrying`)
      const bot = getDispatcherBot()
      const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
      const paId = paCheck?.[0]?.id ?? pendingAction?.id
      const keyboard = buildStaffProposalKeyboard(paId, targetDate, {
        approveLabel: '✅ সব Approve',
        rejectLabel: '❌ বাতিল',
      })
      if (bot && ownerChatId && keyboard) {
        try {
          const retry = await sendMarkdownSafe(
            bot.telegram,
            ownerChatId,
            `⚠️ আজকের টাস্ক proposal পাঠাতে সমস্যা হয়েছিল — আবার পাঠানো হলো:\n\n${proposal.summaryBangla}`,
            { reply_markup: keyboard },
          )
          cardSent = Boolean(retry?.message_id)
        } catch (e) {
          console.error(`[${label}] retry failed:`, e.message)
        }
      }
      if (!cardSent) {
        await notify({
          tier: 2,
          title: '❌ Task proposal পাঠানো যায়নি',
          message: 'আজকের evening proposal owner-কে পৌঁছানো যায়নি। Manually /proposal চালান বা worker চেক করুন।',
          category: 'urgent',
        }).catch(() => {})
      }
    }

    console.log(`[${label}] approval card sent for ${taskData.length} tasks (verified=${cardSent})`)
  } catch (err) {
    console.error(`[${label}] error:`, err.message, err.stack)
    throw err
  }
}

export async function runEveningProposal(supabase) {
  return runTaskProposal(supabase, { targetOffsetDays: 1 })
}
