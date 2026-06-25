/**
 * Intraday Sales-Anomaly Alert (#7).
 * Runs a couple of times during the day (14:00 & 18:00 Dhaka). Pulls a sales-pace
 * snapshot from the Next app's internal API (which reuses the SAME safe order-read
 * path the agent uses — no direct ERP table access here) and warns the owner when
 * today's order count is running far below — or unusually above — the trailing
 * 7-day daily baseline, scaled to the current hour of day.
 *
 * Best-effort: any failure is logged and skipped; never throws.
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_CHAT_ID = () => process.env.TELEGRAM_OWNER_CHAT_ID

function fmtTk(n) {
  return `৳${Number(n || 0).toLocaleString('en-US')}`
}

export async function runSalesAnomaly(context) {
  const { bot } = context
  if (!OWNER_CHAT_ID() || !bot) return { dutyStatus: 'skipped', dutyDetail: 'no owner chat' }
  if (!APP_URL() || !INT()) {
    console.warn('[sales-anomaly] APP_URL or AGENT_INTERNAL_TOKEN missing')
    return { dutyStatus: 'skipped', dutyDetail: 'missing internal API config' }
  }

  let data
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/sales-pace`, {
      headers: { Authorization: `Bearer ${INT()}` },
      signal: AbortSignal.timeout(60_000),
    })
    data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn('[sales-anomaly] API failed:', res.status, data)
      return { dutyStatus: 'error', dutyDetail: `API ${res.status}` }
    }
  } catch (e) {
    console.warn('[sales-anomaly]', e.message)
    return { dutyStatus: 'error', dutyDetail: e.message }
  }

  const hour = Number(data.dhakaHour ?? 0)
  const todayOrders = Number(data?.today?.orders ?? 0)
  const todayRevenue = Number(data?.today?.revenue ?? 0)
  const avgOrders = Number(data?.avg7?.orders ?? 0)
  const avgRevenue = Number(data?.avg7?.revenue ?? 0)

  // Need a meaningful baseline to judge against.
  if (avgOrders < 2) {
    return { dutyStatus: 'done', dutyDetail: 'baseline too small to judge' }
  }

  // Expected fraction of a full day's orders we should have seen by this hour.
  // Bangladesh fashion order flow skews to afternoon/evening, so this is a rough,
  // deliberately conservative curve (never alerts before noon).
  const fractionByHour = (h) => {
    if (h < 12) return 0.2
    if (h < 14) return 0.35
    if (h < 16) return 0.5
    if (h < 18) return 0.65
    if (h < 20) return 0.8
    return 0.95
  }
  const expectedByNow = avgOrders * fractionByHour(hour)
  if (expectedByNow < 1) return { dutyStatus: 'done', dutyDetail: 'expected pace < 1' }

  const ratio = todayOrders / expectedByNow

  let line = null
  if (ratio <= 0.4) {
    line =
      `⚠️ *বিক্রি অস্বাভাবিক কম*\nএখন পর্যন্ত (${hour}টা) মাত্র *${todayOrders}* অর্ডার ` +
      `(${fmtTk(todayRevenue)})।\nগত ৭ দিনের গড় দৈনিক ${avgOrders} অর্ডার — এই সময়ে আরও বেশি আশা করা যেত। ` +
      `\nSir, ad/ক্যাম্পেইন বা সাইট ঠিক আছে কিনা দেখা দরকার হতে পারে।`
  } else if (ratio >= 1.8) {
    line =
      `🔥 *আজ বিক্রি দারুণ চলছে!*\nএখন পর্যন্ত (${hour}টা) *${todayOrders}* অর্ডার ` +
      `(${fmtTk(todayRevenue)}) — গড়ের চেয়ে অনেক বেশি।\nস্টক ও কুরিয়ার প্রস্তুত রাখুন, Sir।`
  }

  if (!line) return { dutyStatus: 'done', dutyDetail: `pace normal (ratio ${ratio.toFixed(2)})` }

  await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID(), line)
  return { dutyStatus: 'done', dutyDetail: `alert sent (ratio ${ratio.toFixed(2)})` }
}
