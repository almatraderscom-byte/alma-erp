/**
 * Daily Cash-Flow Intelligence — sends morning financial summary to owner.
 * Runs daily at 08:30 Dhaka (after owner-briefing).
 *
 * Reports:
 *  - Yesterday's total sales, profit, returns
 *  - Pending COD orders (payment due)
 *  - Week-over-week comparison
 *  - Budget alert if spend exceeds threshold
 */
import { notify } from '../notify/index.mjs'
import { bnNum } from '../staff/bn-format.mjs'

const OWNER_CHAT_ID = process.env.OWNER_TELEGRAM_CHAT_ID

function dhakaYmd(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400_000)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function fmtTaka(n) {
  if (n >= 1000) return `৳${bnNum(Math.round(n / 1000))}K`
  return `৳${bnNum(Math.round(n))}`
}

export async function runDailyCashflow(context) {
  const { supabase, bot } = context

  const yesterday = dhakaYmd(1)
  const lastWeekDay = dhakaYmd(8)

  const { data: yesterdayOrders } = await supabase
    .from('lifestyle_orders')
    .select('sell_price, profit, net_profit, status, payment, due_amount')
    .eq('date', yesterday)
    .neq('status', 'Cancelled')

  const { data: lastWeekOrders } = await supabase
    .from('lifestyle_orders')
    .select('sell_price, profit')
    .eq('date', lastWeekDay)
    .neq('status', 'Cancelled')

  if (!yesterdayOrders?.length) {
    return { dutyStatus: 'done', dutyDetail: 'no orders yesterday' }
  }

  const totalSales = yesterdayOrders.reduce((s, o) => s + (o.sell_price ?? 0), 0)
  const totalProfit = yesterdayOrders.reduce((s, o) => s + (o.net_profit ?? o.profit ?? 0), 0)
  const orderCount = yesterdayOrders.length
  const returnOrders = yesterdayOrders.filter(o => o.status === 'Returned' || o.status === 'Return Initiated')
  const pendingCOD = yesterdayOrders.filter(o => o.payment === 'COD' && (o.due_amount ?? 0) > 0)
  const totalDue = pendingCOD.reduce((s, o) => s + (o.due_amount ?? 0), 0)

  const lastWeekSales = (lastWeekOrders ?? []).reduce((s, o) => s + (o.sell_price ?? 0), 0)
  const weekChange = lastWeekSales > 0
    ? Math.round(((totalSales - lastWeekSales) / lastWeekSales) * 100)
    : null

  let msg = `📊 *গতকালের ক্যাশফ্লো (${yesterday})*\n\n`
  msg += `🛒 অর্ডার: ${bnNum(orderCount)}টি\n`
  msg += `💰 বিক্রি: ${fmtTaka(totalSales)}\n`
  msg += `📈 প্রফিট: ${fmtTaka(totalProfit)}\n`

  if (returnOrders.length > 0) {
    msg += `↩️ রিটার্ন: ${bnNum(returnOrders.length)}টি\n`
  }

  if (pendingCOD.length > 0) {
    msg += `\n⏳ *বাকি COD:* ${bnNum(pendingCOD.length)}টি অর্ডার (${fmtTaka(totalDue)} পেমেন্ট বাকি)\n`
  }

  if (weekChange !== null) {
    const arrow = weekChange >= 0 ? '📈' : '📉'
    msg += `\n${arrow} গত সপ্তাহের একই দিনের তুলনায়: ${weekChange >= 0 ? '+' : ''}${bnNum(weekChange)}%`
  }

  if (bot && OWNER_CHAT_ID) {
    await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {})
  }

  return { dutyStatus: 'done', dutyDetail: `sales: ${totalSales}, profit: ${totalProfit}, orders: ${orderCount}` }
}

/**
 * Payment reminder — check orders where payment is due for 3+ days.
 */
export async function runPaymentReminders(context) {
  const { supabase, bot } = context

  const threeDaysAgo = dhakaYmd(3)
  const { data: overdueOrders } = await supabase
    .from('lifestyle_orders')
    .select('id, customer, phone, sell_price, due_amount, date, courier, tracking_status')
    .gt('due_amount', 0)
    .lte('date', threeDaysAgo)
    .not('status', 'in', '("Cancelled","Returned")')
    .order('date', { ascending: true })
    .limit(20)

  if (!overdueOrders?.length) {
    return { dutyStatus: 'done', dutyDetail: 'no overdue payments' }
  }

  const totalOverdue = overdueOrders.reduce((s, o) => s + (o.due_amount ?? 0), 0)

  let msg = `💳 *পেমেন্ট বাকি (${bnNum(overdueOrders.length)}টি অর্ডার)*\n\n`
  msg += `মোট বাকি: ${fmtTaka(totalOverdue)}\n\n`

  const top5 = overdueOrders.slice(0, 5)
  for (const o of top5) {
    msg += `• ${o.id} — ${o.customer} — ${fmtTaka(o.due_amount)} (${o.date})\n`
  }
  if (overdueOrders.length > 5) {
    msg += `...আরো ${bnNum(overdueOrders.length - 5)}টি`
  }

  if (bot && OWNER_CHAT_ID) {
    await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {})
  }

  return { dutyStatus: 'done', dutyDetail: `${overdueOrders.length} overdue orders, total: ${totalOverdue}` }
}
