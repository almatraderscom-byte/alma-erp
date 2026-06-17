/**
 * Daily Summary Job — 23:30 Asia/Dhaka
 * Sends: day's expenses, task completion, sales snapshot, salah scorecard
 * Format: Bangla text + voice note
 */

import { notify } from '../notify/index.mjs'
import { dhakaTodayYmd, salahDateFilter } from '../salah/dhaka-date.mjs'

const APP_URL   = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runDailySummary({ supabase, bot }) {
  console.log('[daily-summary] starting...')

  const today = dhakaTodayYmd()

  // ── Salah scorecard ───────────────────────────────────────────────────────

  const { data: salahRecords } = await supabase
    .from('salah_records')
    .select('waqt, status')
    .eq('date', salahDateFilter(today))

  const salahCounts = { prayed_on_time: 0, prayed_late: 0, qaza: 0, missed: 0, pending: 0 }
  for (const r of salahRecords ?? []) {
    const s = r.status
    if (s in salahCounts) salahCounts[s]++
  }

  const salahEmoji = salahCounts.prayed_on_time >= 4 ? '🌟' :
                     salahCounts.missed === 0         ? '✅' : '⚠️'
  const salahLine =
    `${salahEmoji} নামাজ: সময়মতো ${salahCounts.prayed_on_time} | দেরিতে ${salahCounts.prayed_late} | কাযা ${salahCounts.qaza} | মিস ${salahCounts.missed}`

  // ── Task completion ───────────────────────────────────────────────────────

  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('status, agent_staff(name)')
    .eq('proposed_for', today)
    .not('status', 'eq', 'cancelled')

  const taskDone    = tasks?.filter(t => t.status === 'done').length ?? 0
  const taskTotal   = tasks?.length ?? 0
  const taskPct     = taskTotal > 0 ? Math.round((taskDone / taskTotal) * 100) : 0
  const taskLine    = `📋 কাজ: ${taskDone}/${taskTotal} সম্পন্ন (${taskPct}%)`

  // ── Finance expenses ──────────────────────────────────────────────────────

  const dayStart = new Date(today + 'T00:00:00+06:00')
  const dayEnd   = new Date(today + 'T23:59:59+06:00')

  const { data: expenses } = await supabase
    .from('finance_expenses')
    .select('amount, currency, category')
    .gte('occurred_at', dayStart.toISOString())
    .lte('occurred_at', dayEnd.toISOString())

  const bdtTotal = Math.round(expenses?.filter(e => e.currency === 'BDT').reduce((s, e) => s + e.amount, 0) ?? 0)
  const aedTotal = Math.round((expenses?.filter(e => e.currency === 'AED').reduce((s, e) => s + e.amount, 0) ?? 0) * 100) / 100
  const expensesParts = []
  if (bdtTotal > 0) expensesParts.push(`৳${bdtTotal.toLocaleString('bn-BD')}`)
  if (aedTotal > 0) expensesParts.push(`AED ${aedTotal.toFixed(2)}`)
  const expenseLine = `💸 খরচ: ${expensesParts.length ? expensesParts.join(' + ') : 'শূন্য'}`

  // ── AI cost (Phase 8) ─────────────────────────────────────────────────────

  let aiCostLine = '🤖 আজকের AI খরচ: $0.00'
  try {
    const spendRes = await fetch(`${APP_URL()}/api/assistant/internal/cost-spend?period=today`, {
      headers: { Authorization: `Bearer ${INT_TOKEN()}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (spendRes.ok) {
      const spend = await spendRes.json()
      const usd = typeof spend.todayUsd === 'number' ? spend.todayUsd : 0
      aiCostLine = `🤖 আজকের AI খরচ: $${usd.toFixed(2)}`
    }
  } catch {
    /* non-fatal */
  }

  // ── Summary message ───────────────────────────────────────────────────────

  const summary =
    `📊 *দৈনিক সারসংক্ষেপ — ${today}*\n\n` +
    `${salahLine}\n` +
    `${taskLine}\n` +
    `${expenseLine}\n` +
    `${aiCostLine}\n\n` +
    (salahCounts.missed > 0
      ? `⚠️ আজ ${salahCounts.missed}টি নামাজ মিস হয়েছে — কাযা পড়ুন, Sir।`
      : `জাযাকাল্লাহ খাইর। ভালো রাত কাটান।`)

  await notify({
    tier:     1,
    title:    'দৈনিক সারসংক্ষেপ',
    message:  summary,
    category: 'report',
    voice:    true,
  })

  console.log(`[daily-summary] sent for ${today}`)
  return {
    dutyStatus: 'done',
    dutyDetail: `কাজ ${taskDone}/${taskTotal}, নামাজ ${salahCounts.prayed_on_time}/5, খরচ ${expensesParts.length ? expensesParts.join('+') : '০'}`,
  }
}
