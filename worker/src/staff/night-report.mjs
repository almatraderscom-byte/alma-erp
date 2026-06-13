/**
 * Night Report Job — 21:00 Asia/Dhaka
 * - Per-staff completion %, done/pending summary
 * - Auto-carry incomplete tasks to tomorrow
 * - Sends to owner via Telegram + voice note
 */

import { notify } from '../notify/index.mjs'
import { aggregateReplyStats } from '../messenger/reply-stats.mjs'
import { bnNum, formatDhakaDateLabel } from './bn-format.mjs'

export async function runNightReport({ supabase, bot }) {
  console.log('[night-report] starting...')

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  const { data: allTasks } = await supabase
    .from('staff_tasks')
    .select(`*, agent_staff(id, name, telegramChatId)`)
    .eq('proposed_for', today)
    .not('status', 'eq', 'cancelled')

  if (!allTasks?.length) {
    await notify({
      tier: 1,
      title: 'রাতের রিপোর্ট',
      message: `${today} — কোনো টাস্ক ছিল না।`,
      category: 'report',
    })
    return
  }

  // Group by staff
  const byStaff = {}
  for (const t of allTasks) {
    const staffId = t.agent_staff?.id || t.staff_id
    if (!byStaff[staffId]) byStaff[staffId] = { staff: t.agent_staff, done: [], pending: [] }
    if (t.status === 'done') byStaff[staffId].done.push(t)
    else byStaff[staffId].pending.push(t)
  }

  const reportLines = []
  const tasksToCarry = []
  const compactParts = []

  for (const { staff, done, pending } of Object.values(byStaff)) {
    const staffName = staff?.name || 'অজানা'
    const total = done.length + pending.length
    const pct = total > 0 ? Math.round((done.length / total) * 100) : 0
    const shortName = staffName.split(' ').pop() ?? staffName
    compactParts.push(`${shortName} ${bnNum(done.length)}/${bnNum(total)} সম্পন্ন`)

    reportLines.push(
      `👤 *${staffName}*: ${done.length}/${total} (${pct}%)\n` +
      (done.length > 0 ? `   ✅ ${done.map(t => t.title).join(', ')}\n` : '') +
      (pending.length > 0 ? `   ⏳ ${pending.map(t => t.title).join(', ')}` : '')
    )

    // Mark pending as carried
    if (pending.length > 0) {
      tasksToCarry.push(...pending)
    }
  }

  // Auto-carry incomplete tasks BEFORE owner notification (evening-proposal reads these at 21:05)
  if (tasksToCarry.length > 0) {
    await supabase
      .from('staff_tasks')
      .update({ status: 'carried' })
      .in('id', tasksToCarry.map(t => t.id))

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

    const carryData = tasksToCarry.map(t => ({
      id:           crypto.randomUUID(),
      staff_id:     t.staff_id,
      title:        `↩ ${t.title}`,
      detail:       t.detail ?? null,
      type:         t.type ?? 'general',
      product_ref:  t.product_ref ?? null,
      status:       'proposed',
      proposed_for: tomorrowStr,
      source:       'carry_forward',
      created_at:   new Date().toISOString(),
    }))

    await supabase.from('staff_tasks').insert(carryData)
    console.log(`[night-report] carried ${tasksToCarry.length} tasks → ${tomorrowStr} as proposed`)
  }

  // Get today's salah summary
  let salahSummary = ''
  try {
    const { salahDateFilter } = await import('../salah/dhaka-date.mjs')
    const { data: salahRecords } = await supabase
      .from('salah_records')
      .select('waqt, status')
      .eq('date', salahDateFilter(today))

    if (salahRecords?.length > 0) {
      const onTime = salahRecords.filter(r => r.status === 'prayed_on_time').length
      const missed = salahRecords.filter(r => r.status === 'missed').length
      salahSummary = `\n\n🕌 *নামাজ:* ${onTime}/5 সময়মতো${missed > 0 ? `, ${missed}টি মিস` : ''}`
    }
  } catch { /* non-fatal */ }

  // Today's sales snapshot (best-effort)
  let salesSummary = ''
  try {
    const salesRes = await fetch(`${process.env.APP_URL}/api/assistant/internal/agent-settings?keys=today_sales_summary`, {
      headers: { Authorization: `Bearer ${process.env.AGENT_INTERNAL_TOKEN}` },
    })
    const data = await salesRes.json()
    if (data.today_sales_summary) salesSummary = `\n\n📊 ${data.today_sales_summary}`
  } catch { /* non-fatal */ }

  // Reply-time stats (Phase 10)
  let replySummary = ''
  try {
    const replyStats = await aggregateReplyStats(supabase, today)
    if (replyStats.length > 0) {
      replySummary = '\n\n💬 *Messenger reply time:*\n' +
        replyStats.map((s) => `• ${s.name} গড় reply: ${s.avgMinutes} মিনিট (${s.count}টি)`).join('\n')
    }
  } catch { /* non-fatal */ }

  // GPS gaps — field tasks done without location today
  let gpsGapLine = ''
  try {
    const { data: doneTasks } = await supabase
      .from('staff_tasks')
      .select('id, staff_id, type')
      .eq('proposed_for', today)
      .eq('status', 'done')
      .in('type', ['stock_check', 'order_followup'])

    const { data: locRows } = await supabase
      .from('staff_locations')
      .select('staff_id')
      .gte('recorded_at', today + 'T00:00:00+06:00')
      .or('metadata.is.null,metadata.neq.stopped')

    const staffWithLoc = new Set((locRows ?? []).map((r) => r.staff_id))
    const gaps = (doneTasks ?? []).filter((t) => !staffWithLoc.has(t.staff_id)).length
    if (gaps > 0) {
      gpsGapLine = `\n\n📍 ফিল্ড টাস্ক Done কিন্তু লোকেশন নেই: ${gaps}টি`
    }
  } catch { /* non-fatal */ }

  let csSummary = ''
  try {
    const csRes = await fetch(`${process.env.APP_URL}/api/assistant/internal/cs-analytics?days=1`, {
      headers: { Authorization: `Bearer ${process.env.AGENT_INTERNAL_TOKEN}` },
    })
    if (csRes.ok) {
      const csData = await csRes.json()
      if (csData.formatted) csSummary = `\n\n${csData.formatted}`
    }
  } catch { /* non-fatal */ }

  let aiCostSummary = ''
  try {
    const dayStart = `${today}T00:00:00+06:00`
    const dayEnd = `${today}T23:59:59.999+06:00`
    const { data: costRows } = await supabase
      .from('agent_cost_events')
      .select('provider, cost_usd')
      .gte('occurred_at', dayStart)
      .lte('occurred_at', dayEnd)

    const byProvider = {}
    for (const row of costRows ?? []) {
      const p = row.provider
      byProvider[p] = (byProvider[p] ?? 0) + Number(row.cost_usd ?? 0)
    }

    const labels = {
      anthropic: 'Anthropic',
      twilio: 'Twilio',
      openai: 'OpenAI',
      gemini: 'Gemini',
      google_tts: 'Google TTS',
    }

    const parts = Object.entries(byProvider)
      .filter(([, v]) => v > 0.0001)
      .sort((a, b) => b[1] - a[1])
      .map(([p, v]) => `${labels[p] ?? p} $${v.toFixed(2)}`)

    if (parts.length) {
      aiCostSummary = `\n\n💰 AI খরচ আজ: ${parts.join(', ')}`
    }
  } catch { /* non-fatal */ }

  const dateLabel = formatDhakaDateLabel(today)
  const carryLine = tasksToCarry.length > 0
    ? `, ${bnNum(tasksToCarry.length)}টি carry-forward`
    : ''
  const compactHeader = `আজকের (${dateLabel}) রিপোর্ট: ${compactParts.join(', ')}${carryLine}`

  const reportText =
    `📋 *${compactHeader}*\n\n` +
    reportLines.join('\n\n') +
    salahSummary +
    salesSummary +
    replySummary +
    csSummary +
    aiCostSummary +
    gpsGapLine +
    (tasksToCarry.length > 0 ? `\n\n↩ ${tasksToCarry.length}টি কাজ আগামীকালের জন্য নিয়ে যাওয়া হয়েছে।` : '')

  await notify({
    tier:     1,
    title:    'রাতের রিপোর্ট',
    message:  reportText,
    category: 'report',
    voice:    true,
  })

  console.log(`[night-report] sent for ${today} — ${allTasks.length} tasks, ${tasksToCarry.length} carried`)
}
