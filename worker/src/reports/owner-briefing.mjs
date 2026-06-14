/**
 * Owner Morning Briefing — synthesizes the whole business into a
 * decision-focused brief. Data from /api/assistant/internal/owner-briefing.
 */
import { fetchOwnerDecisions } from '../memory/owner-decisions.mjs'

export { fetchOwnerDecisions }

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

async function api(path) {
  try {
    const res = await fetch(`${APP_URL()}${path}`, {
      headers: { Authorization: `Bearer ${INT()}` },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Gathers business signals and returns a structured brief object.
 * Each section is best-effort — a failed source becomes null, never throws.
 */
export async function buildOwnerBriefing({ supabase: _supabase } = {}) {
  const brief = await api('/api/assistant/internal/owner-briefing')
  if (!brief) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    return { today, sales: null, pendingOrders: null, inventory: null, reorderSuggestions: [], csWaiting: null, adsDigest: null, staffYesterday: null, decisions: [] }
  }
  return brief
}

/** Filter string suggestions the owner already declined (legacy helper for proposals). */
export function deriveDecisions(suggestions, ownerDecisions) {
  const list = Array.isArray(suggestions) ? suggestions : []
  const decisions = Array.isArray(ownerDecisions) ? ownerDecisions : []
  if (!decisions.length) return list

  const vetoTexts = decisions.map((m) => (m.content || '').toLowerCase())

  return list.filter((suggestion) => {
    const text = String(suggestion).toLowerCase()
    for (const veto of vetoTexts) {
      if (!veto) continue
      if (veto.includes('ad boost') && /(না|no|করো না|avoid)/.test(veto) && text.includes('boost')) {
        const vetoProduct = veto.match(/(fm[-\w\d]+)/i)?.[1]
        const sugProduct = text.match(/(fm[-\w\d]+)/i)?.[1]
        if (!vetoProduct || !sugProduct || vetoProduct === sugProduct) return false
      }
      if (/(না|no|করো না|avoid|বাদ)/.test(veto)) {
        const tokens = veto.split(/\s+/).filter((w) => w.length > 4)
        const overlap = tokens.filter((t) => text.includes(t)).length
        if (overlap >= 2) return false
      }
    }
    return true
  })
}

/** Renders the brief to Bangla text for Telegram. */
export function renderBriefing(brief) {
  const L = []
  L.push(`☀️ *সকালের ব্রিফিং* — ${brief.today}`)
  L.push('')

  const decisions = Array.isArray(brief.decisions) ? brief.decisions : []
  if (decisions.length) {
    L.push('🎯 *আজকের সিদ্ধান্ত:*')
    decisions
      .sort((a, b) => (a.urgency === 'high' ? -1 : 1))
      .forEach((d, i) => {
        const mark = d.urgency === 'high' ? '🔴' : '🟡'
        L.push(`${mark} ${i + 1}. ${d.text}`)
        L.push(`     → ${d.recommend}`)
      })
    L.push('')
  } else {
    L.push('✅ জরুরি সিদ্ধান্ত নেই — সব স্বাভাবিক।')
    L.push('')
  }

  if (brief.sales) {
    const pending = brief.pendingOrders?.count ?? 0
    const staleNote = brief.pendingOrders?.sheetSyncedAt
      ? ` (শীট: ${brief.pendingOrders.sheetSyncedAt.slice(0, 16).replace('T', ' ')})`
      : ''
    L.push(`💰 গতকাল সেল: ৳${brief.sales.yesterdayTotal ?? '—'} | pending: ${pending}টি${staleNote}`)
    if (brief.sales.sevenDayAvg) {
      L.push(`   ৭-দিন গড়: ৳${brief.sales.sevenDayAvg}/দিন | গতকাল অর্ডার: ${brief.sales.yesterdayOrders ?? '—'}`)
    }
  }

  if (brief.csWaiting) {
    L.push(`💬 unreplied: ${brief.csWaiting.unrepliedCount ?? 0} | 24h শেষ হচ্ছে: ${brief.csWaiting.nearWindowCount ?? 0}`)
    if (brief.csWaiting.openAlerts > 0) {
      L.push(`   খোলা messenger alert: ${brief.csWaiting.openAlerts}`)
    }
  }

  const reorderCount = (brief.reorderSuggestions ?? []).length
  if (reorderCount) {
    L.push(`📦 রিঅর্ডার দরকার: ${reorderCount}টি (সেল-রেট অনুযায়ী)`)
  } else {
    const low = (brief.inventory?.items ?? []).length
    if (low) L.push(`📦 কম স্টক আইটেম: ${low}টি`)
  }

  if (brief.adsDigest?.campaigns?.length) {
    const totalSpend = brief.adsDigest.campaigns.reduce((s, c) => s + (c.spend || 0), 0)
    L.push(`📣 গতকাল ad spend: ৳${totalSpend}`)
  }

  if (brief.staffYesterday?.summary) {
    L.push(`👥 গতকাল স্টাফ: ${brief.staffYesterday.summary}`)
  }

  return L.join('\n')
}
