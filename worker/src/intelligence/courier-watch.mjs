/**
 * Courier / Delivery SLA Watch (#10).
 * Once a day (11:00 Dhaka) pulls the courier-watch snapshot from the Next app's
 * internal API (reusing the SAME safe order-read path the agent uses) and reports
 * orders that have been stuck in a non-terminal state past the SLA window, so the
 * owner can chase the courier or the customer.
 *
 * Best-effort: any failure is logged and skipped; never throws.
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_CHAT_ID = () => process.env.TELEGRAM_OWNER_CHAT_ID

const SLA_DAYS = 4

function fmtTk(n) {
  return `৳${Number(n || 0).toLocaleString('en-US')}`
}

export async function runCourierWatch(context) {
  const { bot } = context
  if (!OWNER_CHAT_ID() || !bot) return { dutyStatus: 'skipped', dutyDetail: 'no owner chat' }
  if (!APP_URL() || !INT()) {
    console.warn('[courier-watch] APP_URL or AGENT_INTERNAL_TOKEN missing')
    return { dutyStatus: 'skipped', dutyDetail: 'missing internal API config' }
  }

  let data
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/courier-watch?slaDays=${SLA_DAYS}`, {
      headers: { Authorization: `Bearer ${INT()}` },
      signal: AbortSignal.timeout(60_000),
    })
    data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn('[courier-watch] API failed:', res.status, data)
      return { dutyStatus: 'error', dutyDetail: `API ${res.status}` }
    }
  } catch (e) {
    console.warn('[courier-watch]', e.message)
    return { dutyStatus: 'error', dutyDetail: e.message }
  }

  const orders = Array.isArray(data.orders) ? data.orders : []
  if (!orders.length) {
    return { dutyStatus: 'done', dutyDetail: 'no SLA breaches' }
  }

  const L = [
    `🚚 *ডেলিভারি SLA সতর্কতা* (${SLA_DAYS}+ দিন)`,
    '',
    `*${orders.length}টি* অর্ডার ${SLA_DAYS} দিনের বেশি ধরে এখনো ডেলিভারি হয়নি:`,
    '',
  ]
  orders.slice(0, 12).forEach((o) => {
    const who = o.customerName || o.customerPhone || 'গ্রাহক'
    const ref = o.orderNumber ? `#${o.orderNumber}` : o.id
    const city = o.shippingCity ? `, ${o.shippingCity}` : ''
    L.push(`  • ${ref} — ${who}${city} — ${fmtTk(o.totalAmount)} (${o.ageDays} দিন, ${o.status})`)
  })
  if (orders.length > 12) L.push(`  …আরও ${orders.length - 12}টি।`)
  L.push('', 'Boss, কুরিয়ারে খোঁজ নেওয়া বা গ্রাহককে আপডেট দেওয়া দরকার হতে পারে।')

  await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID(), L.join('\n'))
  return { dutyStatus: 'done', dutyDetail: `${orders.length} breaches reported` }
}
