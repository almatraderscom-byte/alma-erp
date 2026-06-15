/**
 * Proactive staff task proposal — inventory, sales, FB, carry-forward.
 * Used by prepare_staff_task_proposal tool and evening-proposal worker job.
 */
import { prisma } from '@/lib/prisma'
import { getLifestyleOrders } from '@/lib/lifestyle/read'
import { aggregateDashboardMetrics, filterOrdersByDateRange } from '@/lib/order-analytics'
import { listInventory } from '@/lib/agent-api/services/inventory.service'
import { listAgentOrders } from '@/lib/agent-api/orders.service'
import { addDaysYmd, todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { listWebsiteProducts } from '@/lib/website/catalog.service'
import { websiteSupabaseConfigured } from '@/lib/website/supabase-client'
import type { WebsiteProductSummary } from '@/lib/website/types'
import { getRecentPosts, resolvePageId } from '@/agent/lib/meta'
import { trackContentTaskOutcomes } from '@/lib/outcome-wiring'
import type { Order } from '@/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type ProposedTaskInput = {
  staffId: string
  staffName: string
  title: string
  detail?: string
  type: string
  productRef?: string
  source: string
}

type ScoredProduct = {
  productRef: string
  name: string
  business: string
  sales30d: number
  stock: number
  lastPromotedAt: Date | null
  score: number
  reasons: string[]
  taskType: string
}

type StaffProfile = {
  skills: string[]
  dailyTargetTasks: number
  notes: string
}

const DEFAULT_PROFILES: Record<string, StaffProfile> = {
  'Mohammad Eyafi': {
    skills: ['ad_creative', 'product_content', 'product_photo', 'video_reel', 'listing_update', 'order_followup', 'customer_reply', 'page_management', 'offer_idea', 'organic_marketing'],
    dailyTargetTasks: 8,
    notes: 'Handles all creative, content, social media, customer comms',
  },
  'Mustahid': {
    skills: ['product_photo', 'video_reel', 'listing_update', 'office_task', 'page_management', 'content_support', 'organic_marketing'],
    dailyTargetTasks: 6,
    notes: 'Office work, photography, video, page support — NO delivery/packaging/COD',
  },
}

const LEARNING_CURRICULUM: Record<string, Array<{ title: string; detail: string }>> = {
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

function getLearningTaskForStaff(staffName: string, dayIndex: number) {
  for (const [name, curriculum] of Object.entries(LEARNING_CURRICULUM)) {
    const n = staffName.toLowerCase()
    const key = name.toLowerCase()
    if (n.includes(key) || key.includes(n)) {
      return curriculum[dayIndex % curriculum.length] ?? null
    }
  }
  return null
}

let _profileCache: Record<string, StaffProfile> | null = null

export function _resetProfileCache() { _profileCache = null }

async function getStaffProfiles(): Promise<Record<string, StaffProfile>> {
  if (_profileCache) return _profileCache
  try {
    const setting = await db.agentKvSetting.findUnique({ where: { key: 'staff_task_profiles' } })
    if (setting?.value && typeof setting.value === 'object') {
      _profileCache = { ...DEFAULT_PROFILES, ...(setting.value as Record<string, StaffProfile>) }
      return _profileCache
    }
  } catch { /* use defaults */ }
  _profileCache = DEFAULT_PROFILES
  return _profileCache
}

function getProfileForStaff(profiles: Record<string, StaffProfile>, staffName: string): StaffProfile | null {
  for (const [name, profile] of Object.entries(profiles)) {
    if (staffName.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(staffName.toLowerCase())) {
      return profile
    }
  }
  return null
}

function isContentStaff(staff: { name: string; role: string }) {
  return staff.role === 'content' || /eyafi/i.test(staff.name)
}

function staffHasSkill(profile: StaffProfile | null, skill: string): boolean {
  if (!profile) return true
  return profile.skills.includes(skill)
}

function scoreProduct(
  product: {
    sales30d: number
    stock: number
    lastPromotedAt: Date | null
    tags?: string[]
  },
  today = new Date(),
) {
  const { sales30d = 0, stock = 0, lastPromotedAt } = product
  const daysSincePromo = lastPromotedAt
    ? Math.floor((today.getTime() - lastPromotedAt.getTime()) / 86400000)
    : 999

  const reasons: string[] = []
  let score = 0
  const avgWeekly = sales30d / 4

  if (avgWeekly >= 10) {
    score += 100
    reasons.push(`বেস্টসেলার (${sales30d} পিস/৩০ দিন)`)
  } else if (avgWeekly >= 3) {
    score += 60
    reasons.push(`ভালো বিক্রি (${sales30d} পিস/৩০ দিন)`)
  } else {
    score += 20
    reasons.push('স্লো মুভার — প্রমোশন দরকার')
  }

  if (daysSincePromo >= 30) {
    score += daysSincePromo >= 60 ? 40 : 25
    reasons.push(`${daysSincePromo} দিন প্রমোশন হয়নি`)
  } else if (daysSincePromo < 2) {
    score -= 30
    reasons.push('সম্প্রতি প্রমোট হয়েছে')
  }

  if (stock > 20 && sales30d < 5) {
    score += Math.min(40, Math.floor(stock / 5))
    reasons.push(`স্টক প্রেশার: ${stock} স্টক, ${sales30d} বিক্রি`)
  } else if (stock === 0) {
    score -= 50
    reasons.push('স্টক শেষ')
  }

  let taskType = 'product_content'
  if (avgWeekly >= 10) taskType = 'ad_creative'
  else if (sales30d === 0 && stock > 0) taskType = 'listing_update'

  return { score, reasons, taskType }
}

function pickRotation(products: ScoredProduct[], today = new Date()) {
  const scored = products
    .map((p) => ({ ...p, ...scoreProduct(p, today) }))
    .sort((a, b) => b.score - a.score)

  let picks = scored.filter((p) => p.stock > 0).slice(0, 4)
  if (picks.length < 2) picks = scored.slice(0, 4)
  return picks
}

function buildTasksForStaff(
  staff: { id: string; name: string; role: string },
  picks: ScoredProduct[],
  carryForward: Array<{ staffId: string; title: string; detail: string | null; type: string; productRef: string | null }>,
  pendingOrders: number,
  profile: StaffProfile | null,
) {
  const tasks: Omit<ProposedTaskInput, 'staffName'>[] = []
  const targetCount = profile?.dailyTargetTasks ?? 5

  // Carry-forward tasks first
  for (const carried of carryForward.filter((t) => t.staffId === staff.id)) {
    if (!staffHasSkill(profile, carried.type)) continue
    tasks.push({
      staffId: staff.id,
      title: `↩ ${carried.title} (গতকালের কাজ)`,
      detail: carried.detail ?? undefined,
      type: carried.type || 'misc',
      productRef: carried.productRef ?? undefined,
      source: 'pattern',
    })
  }

  if (isContentStaff(staff)) {
    // Content staff: ad creatives, product content, order followup
    for (const pick of picks.slice(0, 3)) {
      const type = pick.taskType || 'product_content'
      if (!staffHasSkill(profile, type)) continue
      tasks.push({
        staffId: staff.id,
        title:
          type === 'ad_creative'
            ? `${pick.name} — FB/অ্যাড ক্রিয়েটিভ তৈরি করুন`
            : `${pick.name} — কন্টেন্ট ও পোস্ট তৈরি করুন`,
        detail: pick.reasons.slice(0, 3).join('; '),
        type,
        productRef: pick.productRef,
        source: 'rotation',
      })
    }
    if (pendingOrders > 0 && staffHasSkill(profile, 'order_followup')) {
      tasks.push({
        staffId: staff.id,
        title: `${pendingOrders}টি পেন্ডিং অর্ডার ফলো-আপ করুন`,
        detail: 'কাস্টমার কল/মেসেজ — কনফার্ম বা ডেলিভারি আপডেট',
        type: 'order_followup',
        source: 'pattern',
      })
    }
    // Video reel task
    if (staffHasSkill(profile, 'video_reel') && picks.length > 0) {
      const reelPick = picks.find((p) => p.sales30d >= 5) ?? picks[0]
      tasks.push({
        staffId: staff.id,
        title: `${reelPick.name} — ৩০-সেকেন্ড ভিডিও রিল বানান`,
        detail: `FB/Insta-তে পোস্ট করুন। ${reelPick.reasons[0] ?? 'বেশি বিক্রির পণ্য'} হাইলাইট করুন`,
        type: 'video_reel',
        productRef: reelPick.productRef,
        source: 'rotation',
      })
    }
    // Page management task
    if (staffHasSkill(profile, 'page_management')) {
      tasks.push({
        staffId: staff.id,
        title: 'পেজ ম্যানেজমেন্ট — কভার/পিন পোস্ট/স্টোরি আপডেট',
        detail: 'FB + Insta story, pinned post চেক ও আপডেট করুন',
        type: 'page_management',
        source: 'agent',
      })
    }
    // Customer reply task
    if (staffHasSkill(profile, 'customer_reply')) {
      tasks.push({
        staffId: staff.id,
        title: 'কাস্টমার মেসেজ/কমেন্ট রিপ্লাই — সব পেজ চেক',
        detail: 'Messenger + FB comment — আনরিড মেসেজ রিপ্লাই দিন',
        type: 'customer_reply',
        source: 'agent',
      })
    }
  } else {
    // Non-content staff: use profile skills, skip stock_check/COD if not in profile
    for (const pick of picks.slice(0, 2)) {
      if (staffHasSkill(profile, 'product_photo')) {
        tasks.push({
          staffId: staff.id,
          title: `${pick.name} — প্রোডাক্ট ফটো শুট`,
          detail: `নতুন ছবি তুলুন, ক্যাটালগে যোগ করুন। স্টক: ${pick.stock}`,
          type: 'product_photo',
          productRef: pick.productRef,
          source: 'rotation',
        })
      }
    }
    if (staffHasSkill(profile, 'video_reel') && picks.length > 0) {
      const reelPick = picks.find((p) => p.sales30d >= 3) ?? picks[0]
      tasks.push({
        staffId: staff.id,
        title: `${reelPick.name} — প্রোডাক্ট ভিডিও/রিল তৈরি`,
        detail: `ছোট ভিডিও বানান — পণ্যের ফিচার দেখান`,
        type: 'video_reel',
        productRef: reelPick.productRef,
        source: 'rotation',
      })
    }
    if (staffHasSkill(profile, 'listing_update')) {
      const listingPick = picks.find((p) => p.taskType === 'listing_update' && p.stock > 0)
      if (listingPick) {
        tasks.push({
          staffId: staff.id,
          title: `${listingPick.name} — লিস্টিং আপডেট (ছবি/বর্ণনা)`,
          detail: `${listingPick.reasons[0] ?? 'বিক্রি বাড়াতে লিস্টিং উন্নত করুন'}`,
          type: 'listing_update',
          productRef: listingPick.productRef,
          source: 'rotation',
        })
      }
    }
    if (staffHasSkill(profile, 'page_management')) {
      tasks.push({
        staffId: staff.id,
        title: 'পেজ সাপোর্ট — কমেন্ট রিপ্লাই ও পোস্ট শিডিউল চেক',
        detail: 'FB/Insta পেজে আনরিড কমেন্ট রিপ্লাই দিন',
        type: 'page_management',
        source: 'agent',
      })
    }
    if (staffHasSkill(profile, 'content_support')) {
      tasks.push({
        staffId: staff.id,
        title: 'কন্টেন্ট সাপোর্ট — Eyafi ভাইকে শুটে সাহায্য',
        detail: 'প্রোডাক্ট সাজানো, লাইটিং সেটআপ, ব্যাকগ্রাউন্ড প্রস্তুত',
        type: 'content_support',
        source: 'agent',
      })
    }
    if (staffHasSkill(profile, 'office_task')) {
      tasks.push({
        staffId: staff.id,
        title: 'অফিস ক্লিন-আপ ও প্রোডাক্ট অর্গানাইজ',
        detail: 'শোরুম/গোডাউন গুছিয়ে রাখুন, নতুন স্টক সাজান',
        type: 'office_task',
        source: 'agent',
      })
    }
    // Only add stock_check if the profile allows it
    if (staffHasSkill(profile, 'stock_check')) {
      for (const pick of picks.slice(2, 4)) {
        tasks.push({
          staffId: staff.id,
          title: `${pick.name} — স্টক চেক করুন`,
          detail: `বর্তমান স্টক: ${pick.stock}. ${pick.reasons[0] ?? ''}`,
          type: 'stock_check',
          productRef: pick.productRef,
          source: 'rotation',
        })
      }
    }
  }

  // Trim to target count (carry-forwards always kept)
  const carryCount = tasks.filter((t) => t.source === 'pattern' && t.title.startsWith('↩')).length
  let trimmed: Omit<ProposedTaskInput, 'staffName'>[]
  if (tasks.length > targetCount + carryCount) {
    const carries = tasks.filter((t) => t.title.startsWith('↩'))
    const rest = tasks.filter((t) => !t.title.startsWith('↩')).slice(0, targetCount)
    trimmed = [...carries, ...rest]
  } else {
    trimmed = tasks
  }

  const dayIndex = Math.floor(Date.now() / 86_400_000)
  const learning = getLearningTaskForStaff(staff.name, dayIndex)
  if (learning) {
    trimmed.push({
      staffId: staff.id,
      title: `📚 ${learning.title}`,
      detail: learning.detail,
      type: 'learning',
      source: 'pattern',
    })
  }

  return trimmed.map((t) => ({ ...t, staffName: staff.name }))
}

function formatSummary(
  date: string,
  staffList: Array<{ name: string }>,
  tasks: ProposedTaskInput[],
  picks: ScoredProduct[],
  carryCount: number,
  pendingOrders: number,
) {
  const byStaff = staffList.map((s) => {
    const sTasks = tasks.filter((t) => t.staffName === s.name)
    return `*${s.name}* (${sTasks.length}টি):\n${sTasks.map((t) => `  • ${t.title}`).join('\n')}`
  })

  const topLine = picks
    .slice(0, 3)
    .map((p) => `  • ${p.name}: ${p.reasons[0] ?? ''}`)
    .join('\n')

  let msg =
    `📋 *আজকের স্টাফ টাস্ক প্রস্তাব* — ${date}\n\n` +
    byStaff.join('\n\n') +
    (topLine ? `\n\n🔥 *বেস্টসেলার/ফোকাস পণ্য (৩০ দিন):*\n${topLine}` : '') +
    (pendingOrders > 0 ? `\n\n📦 পেন্ডিং অর্ডার: ${pendingOrders}টি` : '')

  if (carryCount > 0) {
    msg += `\n\n⚠️ গতকালের ${carryCount}টি অসম্পূর্ণ কাজ যোগ করা হয়েছে।`
  }

  return msg
}

type PatternFlags = {
  staleProductTasks: ProposedTaskInput[]
  lateTypeFlags: string[]
  messengerAlertLine: string | null
}

async function detectPatterns(
  dateYmd: string,
  staffList: Array<{ id: string; name: string; role: string }>,
  inv: { items: Array<{ sku: string; name: string; currentStock: number }> },
  historyRows: Array<{ productRef: string; business: string; lastPromotedAt: Date }>,
): Promise<PatternFlags> {
  const staleProductTasks: ProposedTaskInput[] = []
  const lateTypeFlags: string[] = []
  let messengerAlertLine: string | null = null

  const cutoff30 = new Date(`${addDaysYmd(dateYmd, -30)}T00:00:00+06:00`)
  const recentPromo = new Map<string, Date>()
  for (const h of historyRows) {
    const k = `${h.business}:${h.productRef}`
    const prev = recentPromo.get(k)
    if (!prev || h.lastPromotedAt > prev) recentPromo.set(k, h.lastPromotedAt)
  }

  const contentStaff = staffList.find((s) => isContentStaff(s))
  for (const item of inv.items) {
    if (item.currentStock <= 0) continue
    const key = `ALMA Lifestyle:${item.sku}`
    const lastAt = recentPromo.get(key)
    if (lastAt && lastAt >= cutoff30) continue
    if (!contentStaff) continue
    const days = lastAt
      ? Math.floor((Date.now() - lastAt.getTime()) / 86400000)
      : 999
    staleProductTasks.push({
      staffId: contentStaff.id,
      staffName: contentStaff.name,
      title: `${item.name} — ৩০+ দিন মার্কেটিং হয়নি, কন্টেন্ট তৈরি করুন`,
      detail: `স্টক: ${item.currentStock}। ${days >= 999 ? 'কখনো প্রমোট হয়নি' : `${days} দিন প্রমোশন হয়নি`}`,
      type: 'product_content',
      productRef: item.sku,
      source: 'pattern',
    })
  }

  const from14 = new Date(`${addDaysYmd(dateYmd, -14)}T00:00:00+06:00`)
  const lateTasks = await db.agentStaffTask.findMany({
    where: {
      proposedFor: { gte: from14 },
      status: { in: ['carried', 'sent'] },
    },
    select: { type: true },
  })
  const typeCounts: Record<string, number> = {}
  for (const t of lateTasks) {
    const ty = t.type || 'misc'
    typeCounts[ty] = (typeCounts[ty] ?? 0) + 1
  }
  for (const [ty, count] of Object.entries(typeCounts)) {
    if (count >= 3) {
      const label = ty === 'stock_check' ? 'stock check' : ty.replace(/_/g, ' ')
      lateTypeFlags.push(`⚠️ ${label} ${count} বার late/carried (১৪ দিন)`)
    }
  }

  const alertCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const staleAlerts = await db.agentMessengerAlert.count({
    where: { resolved: false, detectedAt: { lt: alertCutoff } },
  })
  if (staleAlerts > 0) {
    messengerAlertLine = `📨 ${staleAlerts}টি Messenger alert ২৪+ ঘণ্টা unresolved — owner action দরকার`
  }

  return { staleProductTasks: staleProductTasks.slice(0, 3), lateTypeFlags, messengerAlertLine }
}

/**
 * Daily website-driven organic marketing task — rotates 3 styles by day index.
 * Rule-based, no extra LLM call. Silently returns null if website Supabase isn't
 * configured or no product qualifies — must never break the evening proposal job.
 */
async function detectWebsiteMarketingPattern(
  dateYmd: string,
  staffList: Array<{ id: string; name: string; role: string }>,
): Promise<ProposedTaskInput | null> {
  if (!websiteSupabaseConfigured()) return null

  let products: WebsiteProductSummary[]
  try {
    products = await listWebsiteProducts({ publishedOnly: true, limit: 200 })
  } catch {
    return null
  }
  if (!products.length) return null

  const mustahid = staffList.find((s) => s.name.toLowerCase().includes('mustahid'))
  const eyafi = staffList.find((s) => s.name.toLowerCase().includes('eyafi'))

  const dayIndex = Math.floor(new Date(`${dateYmd}T00:00:00+06:00`).getTime() / 86400000)
  const rotation = dayIndex % 3

  const now = Date.now()
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

  // Day A: image/content refresh — published, not updated in 30+ days
  if (rotation === 0 && mustahid) {
    const stale = products
      .filter((p) => now - new Date(p.updatedAt).getTime() >= THIRTY_DAYS_MS)
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
    const target = stale[0]
    if (target) {
      const days = Math.floor((now - new Date(target.updatedAt).getTime()) / 86400000)
      return {
        staffId: mustahid.id,
        staffName: mustahid.name,
        title: `ওয়েবসাইট: ${target.name} — ছবি/কনটেন্ট আপডেট করুন`,
        detail: `এই প্রোডাক্টের ওয়েবসাইট লিস্টিং ${days} দিন আপডেট হয়নি (slug: ${target.slug})। নতুন ছবি তুলে বা existing ছবি রিফ্রেশ করে owner-কে দিন — Approve হলে website-এ আপডেট হবে।`,
        type: 'organic_marketing',
        productRef: target.sku,
        source: 'website_pattern',
      }
    }
  }

  // Day B: offer idea — published, in-stock, featured preferred
  if (rotation === 1 && eyafi) {
    const inStock = products.filter((p) => p.stock > 0)
    const featured = inStock.filter((p) => p.featured)
    const target = (featured.length ? featured : inStock).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0]
    if (target) {
      return {
        staffId: eyafi.id,
        staffName: eyafi.name,
        title: `অফার আইডিয়া: ${target.name}`,
        detail: `${target.name} (দাম: ৳${target.price}, স্টক: ${target.stock})${target.featured ? ' — ফিচারড প্রোডাক্ট' : ''} এর জন্য একটা ডিসকাউন্ট/বান্ডেল/কম্বো অফার আইডিয়া বানিয়ে owner-কে দিন।`,
        type: 'offer_idea',
        productRef: target.sku,
        source: 'website_pattern',
      }
    }
  }

  // Day C: organic cross-platform push — recently published/updated
  if (rotation === 2 && mustahid) {
    const recent = products
      .filter((p) => now - new Date(p.updatedAt).getTime() <= SEVEN_DAYS_MS)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    const target = recent[0]
    if (target) {
      return {
        staffId: mustahid.id,
        staffName: mustahid.name,
        title: `অর্গানিক প্রমোশন: ${target.name}`,
        detail: `${target.name} (slug: ${target.slug}) সম্প্রতি ওয়েবসাইটে আপডেট/পাবলিশ হয়েছে। এটা FB গ্রুপ বা অন্য ফ্রি প্ল্যাটফর্মে অর্গানিকভাবে শেয়ার করুন যাতে নতুন কাস্টমার আসে। শেয়ার করার পর owner-কে লিংক/স্ক্রিনশট দিন।`,
        type: 'organic_marketing',
        productRef: target.sku,
        source: 'website_pattern',
      }
    }
  }

  return null
}

export async function buildStaffTaskProposal(dateYmd = todayYmdDhaka()) {
  // Lifestyle staff only — Trading staff are handled by buildTradingTaskProposal.
  const staffList = await db.agentStaff.findMany({
    where: { active: true, businessId: 'ALMA_LIFESTYLE' },
    select: { id: true, name: true, role: true, telegramChatId: true },
    orderBy: { name: 'asc' },
  })

  if (!staffList.length) {
    return { success: false as const, error: 'কোনো active staff পাওয়া যায়নি' }
  }

  const yesterday = addDaysYmd(dateYmd, -1)
  const from30 = addDaysYmd(dateYmd, -30)

  const [carryRows, historyRows, inv, orders30, pendingRes, fbPosts] = await Promise.all([
    db.agentStaffTask.findMany({
      where: {
        proposedFor: new Date(`${yesterday}T00:00:00+06:00`),
        status: { in: ['sent', 'approved'] },
        businessId: 'ALMA_LIFESTYLE',
      },
      select: { staffId: true, title: true, detail: true, type: true, productRef: true },
    }),
    db.agentProductMarketingHistory.findMany({
      orderBy: { lastPromotedAt: 'asc' },
      take: 200,
    }),
    listInventory().catch(() => ({ items: [] as Array<{ sku: string; name: string; currentStock: number }> })),
    (async () => {
      try {
        const raw = await getLifestyleOrders({ business_id: 'ALMA_LIFESTYLE', limit: '500' })
        const orders = raw.orders ?? []
        return filterOrdersByDateRange(orders, { start: from30, end: dateYmd })
      } catch {
        return [] as Order[]
      }
    })(),
    listAgentOrders({ status: 'pending', limit: 100 }).catch(() => ({ orders: [], meta: { count: 0 } })),
    getRecentPosts({ pageId: resolvePageId('lifestyle'), limit: 8 }).catch(() => []),
  ])

  const metrics = aggregateDashboardMetrics(orders30)
  const topProducts = metrics.top_products.slice(0, 15)

  const historyMap = new Map<string, Date>()
  for (const row of historyRows) {
    const key = `${row.business}:${row.productRef}`
    if (!historyMap.has(key)) historyMap.set(key, row.lastPromotedAt)
  }

  const stockMap = new Map(inv.items.map((i) => [i.sku, i]))

  const products: ScoredProduct[] = topProducts.map((tp) => {
    const stockItem = stockMap.get(tp.product) ?? [...stockMap.values()].find((s) => s.name === tp.product)
    return {
      productRef: tp.product,
      name: tp.product,
      business: 'ALMA Lifestyle',
      sales30d: tp.pieces,
      stock: stockItem?.currentStock ?? 0,
      lastPromotedAt: historyMap.get(`ALMA Lifestyle:${tp.product}`) ?? null,
      score: 0,
      reasons: [],
      taskType: 'product_content',
    }
  })

  if (products.length < 4) {
    for (const item of inv.items.filter((i) => i.currentStock > 0).slice(0, 10)) {
      if (products.some((p) => p.productRef === item.sku)) continue
      products.push({
        productRef: item.sku,
        name: item.name,
        business: 'ALMA Lifestyle',
        sales30d: 0,
        stock: item.currentStock,
        lastPromotedAt: historyMap.get(`ALMA Lifestyle:${item.sku}`) ?? null,
        score: 0,
        reasons: [],
        taskType: 'listing_update',
      })
    }
  }

  const picks = pickRotation(products)
  const pendingOrders = pendingRes.meta.count

  const patterns = await detectPatterns(dateYmd, staffList, inv, historyRows)
  const websiteTask = await detectWebsiteMarketingPattern(dateYmd, staffList).catch(() => null)
  const profiles = await getStaffProfiles()

  const allTasks: ProposedTaskInput[] = []
  for (const staff of staffList) {
    const profile = getProfileForStaff(profiles, staff.name)
    allTasks.push(...buildTasksForStaff(staff, picks, carryRows, pendingOrders, profile))
  }
  for (const pt of patterns.staleProductTasks) {
    if (!allTasks.some((t) => t.productRef === pt.productRef && t.type === pt.type)) {
      allTasks.push(pt)
    }
  }
  if (websiteTask && !allTasks.some((t) => t.productRef === websiteTask.productRef && t.type === websiteTask.type)) {
    allTasks.push(websiteTask)
  }

  let summaryBangla = formatSummary(dateYmd, staffList, allTasks, picks, carryRows.length, pendingOrders)
  if (patterns.lateTypeFlags.length > 0) {
    summaryBangla += `\n\n*প্যাটার্ন সতর্কতা:*\n${patterns.lateTypeFlags.join('\n')}`
  }
  if (patterns.messengerAlertLine) {
    summaryBangla += `\n\n${patterns.messengerAlertLine}`
  }
  if (websiteTask) {
    summaryBangla += `\n\n🌐 ওয়েবসাইট থেকে ১টি মার্কেটিং টাস্ক যুক্ত হয়েছে: ${websiteTask.title}`
  }

  void trackContentTaskOutcomes(allTasks).catch(() => {})

  const fbRecent = Array.isArray(fbPosts)
    ? fbPosts.slice(0, 3).map((p: { message?: string; created_time?: string }) => ({
        snippet: (p.message ?? '').slice(0, 80),
        at: p.created_time,
      }))
    : []

  return {
    success: true as const,
    date: dateYmd,
    staff: staffList,
    tasks: allTasks,
    rotationPicks: picks.map((p) => ({
      productRef: p.productRef,
      name: p.name,
      sales30d: p.sales30d,
      stock: p.stock,
      reasons: p.reasons,
      taskType: p.taskType,
    })),
    carryForwardCount: carryRows.length,
    pendingOrders,
    topProducts: topProducts.slice(0, 5).map((p) => ({
      product: p.product,
      pieces: p.pieces,
      revenue: p.revenue,
    })),
    fbRecent,
    summaryBangla,
    note: 'ডেটা: ইনভেন্টরি + ৩০ দিনের অর্ডার + FB পোস্ট + গতকালের carry-forward',
  }
}
