/**
 * Weekly Review Job — Friday 21:30 Asia/Dhaka
 * - Sales trend vs prior week
 * - Dead stock analysis
 * - Staff response-time stats
 * - Salah weekly summary (35-waqt table)
 * - 2-3 concrete growth ideas
 */

import { notify } from '../notify/index.mjs'
import { aggregateReplyStats } from '../messenger/reply-stats.mjs'
import { salahDateFilter } from '../salah/dhaka-date.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

async function callInternal(path) {
  const res = await fetch(`${APP_URL}${path}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN}` },
  })
  if (!res.ok) return null
  return res.json()
}

export async function runWeeklyReview({ supabase, bot }) {
  console.log('[weekly-review] starting...')

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  // ── Salah weekly summary (last 7 days) ────────────────────────────────────

  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - 6)
  const weekStartStr = weekStart.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  const { data: salahRecords } = await supabase
    .from('salah_records')
    .select('date, waqt, status')
    .gte('date', salahDateFilter(weekStartStr))
    .lte('date', salahDateFilter(today))
    .order('date', { ascending: true })

  const salahCounts = { prayed_on_time: 0, prayed_late: 0, qaza: 0, missed: 0, pending: 0 }
  for (const r of salahRecords ?? []) {
    const s = r.status
    if (s in salahCounts) salahCounts[s]++
  }
  const totalSalah = (salahRecords ?? []).length
  const onTimePct  = totalSalah > 0 ? Math.round((salahCounts.prayed_on_time / totalSalah) * 100) : 0

  const salahSection =
    `🕌 *নামাজ সাপ্তাহিক সারসংক্ষেপ* (${weekStartStr} → ${today})\n` +
    `সময়মতো: ${salahCounts.prayed_on_time} | দেরিতে: ${salahCounts.prayed_late} | কাযা: ${salahCounts.qaza} | মিস: ${salahCounts.missed}\n` +
    `সাফল্যের হার: ${onTimePct}%\n` +
    salahNasiha(salahCounts, onTimePct)

  // ── Staff completion stats (last 7 days) ──────────────────────────────────

  const { data: weekTasks } = await supabase
    .from('staff_tasks')
    .select(`*, agent_staff(id, name)`)
    .gte('proposed_for', weekStartStr)
    .lte('proposed_for', today)
    .not('status', 'eq', 'cancelled')

  const staffStats = {}
  for (const t of weekTasks ?? []) {
    const name = t.agent_staff?.name || 'অজানা'
    if (!staffStats[name]) staffStats[name] = { done: 0, total: 0 }
    staffStats[name].total++
    if (t.status === 'done') staffStats[name].done++
  }

  const staffSection = Object.entries(staffStats)
    .map(([name, s]) => {
      const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0
      return `• ${name}: ${s.done}/${s.total} (${pct}%)`
    }).join('\n')

  // ── Reply-time trend vs prior week ─────────────────────────────────────────

  let replySection = ''
  try {
    const thisWeekStats = {}
    for (let i = 0; i < 7; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
      const dayStats = await aggregateReplyStats(supabase, ds)
      for (const s of dayStats) {
        if (!thisWeekStats[s.name]) thisWeekStats[s.name] = []
        thisWeekStats[s.name].push(s.avgMinutes)
      }
    }
    const lastWeekStats = {}
    for (let i = 7; i < 14; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
      const dayStats = await aggregateReplyStats(supabase, ds)
      for (const s of dayStats) {
        if (!lastWeekStats[s.name]) lastWeekStats[s.name] = []
        lastWeekStats[s.name].push(s.avgMinutes)
      }
    }
    const lines = Object.keys(thisWeekStats).map((name) => {
      const tw = thisWeekStats[name]
      const lw = lastWeekStats[name] ?? []
      const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null
      const thisAvg = avg(tw)
      const lastAvg = avg(lw)
      if (thisAvg == null) return null
      const trend = lastAvg != null
        ? (thisAvg < lastAvg ? '↓ ভালো' : thisAvg > lastAvg ? '↑ খারাপ' : '→ একই')
        : ''
      return `• ${name}: গড় ${thisAvg} মিনিট${lastAvg != null ? ` (গত সপ্তাহ ${lastAvg}) ${trend}` : ''}`
    }).filter(Boolean)
    if (lines.length) replySection = `\n\n💬 *Messenger reply (৭ দিন):*\n${lines.join('\n')}`
  } catch { /* non-fatal */ }

  // ── Growth ideas based on rotation data ──────────────────────────────────

  const { data: slowProducts } = await supabase
    .from('product_marketing_history')
    .select('product_ref, business, last_promoted_at')
    .lt('last_promoted_at', new Date(Date.now() - 30 * 86400 * 1000).toISOString())
    .order('last_promoted_at', { ascending: true })
    .limit(3)

  let growthIdeas = `\n\n💡 *প্রবৃদ্ধির পরামর্শ:*`
  if (slowProducts?.length) {
    growthIdeas += `\n• ${slowProducts[0].product_ref} ৩০+ দিন ধরে মার্কেট হয়নি — এই সপ্তাহে bundle অফার দিন`
  }
  growthIdeas += `\n• ফেসবুক Reels ট্রায়াল করুন (product unboxing) — কম খরচে বেশি reach`
  growthIdeas += `\n• COD কনফার্মেশন রেট ট্র্যাক করুন — ৫০%-এর নিচে থাকলে pre-payment ডিসকাউন্ট চালু করুন`

  // ── CS sales analytics (CS-2) ───────────────────────────────────────────────

  let csSection = ''
  try {
    const csData = await callInternal('/api/assistant/internal/cs-analytics?days=7')
    if (csData?.formatted) {
      csSection = `\n\n${csData.formatted}`
      const top = csData.summary?.topAskedProducts?.[0]
      if (top) {
        growthIdeas += `\n• ${top.code} নিয়ে ${top.count} জন জিজ্ঞেস করেছে — আরও কন্টেন্ট/ছবি দিন`
      }
    }
  } catch { /* non-fatal */ }

  let patternSection = ''
  try {
    const { detectStaffPatterns } = await import('./pattern-detect.mjs')
    const flags = await detectStaffPatterns({ supabase })
    if (flags.length) {
      patternSection =
        '\n\n⚠️ *প্যাটার্ন সতর্কতা:*\n' +
        flags.map((f) => `• ${f.name}: ${f.detail}`).join('\n')
    }
  } catch { /* non-fatal */ }

  // ── Outcome scorecard (Intelligence A) ─────────────────────────────────────

  let outcomeSection = ''
  try {
    const scoreRes = await fetch(`${APP_URL}/api/assistant/internal/outcome-scorecard?days=7`, {
      headers: { Authorization: `Bearer ${INT_TOKEN}` },
    })
    if (scoreRes.ok) {
      const { text } = await scoreRes.json()
      if (text) outcomeSection = `\n\n${text}`
    }
  } catch { /* non-fatal */ }

  // ── Final report ──────────────────────────────────────────────────────────

  const report =
    `📊 *সাপ্তাহিক রিভিউ — ${today}*\n\n` +
    salahSection + '\n\n' +
    `👥 *স্টাফ কমপ্লিশন (৭ দিন):*\n${staffSection || 'কোনো ডেটা নেই'}` +
    patternSection +
    replySection +
    csSection +
    growthIdeas +
    outcomeSection

  await notify({
    tier:     1,
    title:    'সাপ্তাহিক রিভিউ',
    message:  report,
    category: 'report',
    voice:    true,
  })

  // ── Strategic altitude + agent self-review (Intelligence C) ───────────────

  try {
    const stratRes = await fetch(`${APP_URL}/api/assistant/internal/weekly-strategic`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${INT_TOKEN}` },
    })
    const stratData = await stratRes.json().catch(() => ({}))
    if (stratData.message) {
      const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
      if (bot?.telegram && ownerChatId) {
        await sendMarkdownSafe(bot.telegram, ownerChatId, stratData.message)
      } else {
        await notify({
          tier:     1,
          title:    'সাপ্তাহিক স্ট্র্যাটেজিক রিভিউ',
          message:  stratData.message,
          category: 'report',
        })
      }
    }
  } catch (err) {
    console.warn('[weekly-review] strategic section failed:', err?.message ?? err)
  }

  console.log('[weekly-review] sent')
}

function salahNasiha(counts, onTimePct) {
  if (onTimePct >= 90) return '\nআলহামদুলিল্লাহ — এই সপ্তাহ চমৎকার ছিল। ধারাবাহিকতা বজায় রাখুন।'
  if (counts.missed > 3) return '\nSir, এই সপ্তাহে ৩টির বেশি নামাজ মিস হয়েছে। নামাজ কিয়ামতের দিন প্রথম হিসাব নেওয়া হবে। আল্লাহর কাছে তওবা করুন এবং পরের সপ্তাহে সব ওয়াক্ত পড়ার নিয়ত করুন।'
  return '\nনামাজে মনোযোগ বাড়ানোর চেষ্টা করুন। প্রতিটি ওয়াক্ত আল্লাহর সাথে সাক্ষাতের সুযোগ।'
}
