/**
 * Night Report Job — 21:00 Asia/Dhaka
 * - Per-staff completion %, done/pending summary
 * - Auto-carry incomplete tasks to tomorrow
 * - Sends to owner via Telegram + voice note
 */

import { notify } from '../notify/index.mjs'
import { aggregateReplyStats } from '../messenger/reply-stats.mjs'
import { bnNum, formatDhakaDateLabel } from './bn-format.mjs'
import { normalizeStaffTaskSource } from './task-source.mjs'
import { normalizeStaffTaskType } from './task-type.mjs'
import { getAppUrl, getInternalToken } from '../env.mjs'

export async function runNightReport({ supabase, bot }) {
  console.log('[night-report] starting...')

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  const { data: todayLunches } = await supabase
    .from('staff_lunch')
    .select('staff_id, staff_name, duration_min, overage, ended_at, started_at')
    .eq('lunch_date', today)

  const lunchByStaff = {}
  for (const l of todayLunches ?? []) {
    lunchByStaff[l.staff_id] = l
  }

  // Repeat overruns in last 7 days (pattern flag)
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)
  const weekAgoStr = weekAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const { data: weekOverruns } = await supabase
    .from('staff_lunch')
    .select('staff_id')
    .eq('overage', true)
    .gte('lunch_date', weekAgoStr)
    .lte('lunch_date', today)

  const overrunCountByStaff = {}
  for (const r of weekOverruns ?? []) {
    overrunCountByStaff[r.staff_id] = (overrunCountByStaff[r.staff_id] ?? 0) + 1
  }

  const { data: allTasks } = await supabase
    .from('staff_tasks')
    .select(`*, business_id, agent_staff(id, name, telegramChatId, business_id)`)
    .eq('proposed_for', today)
    .not('status', 'eq', 'cancelled')

  if (!allTasks?.length) {
    await notify({
      tier: 1,
      title: 'রাতের রিপোর্ট',
      message: `${today} — কোনো টাস্ক ছিল না।`,
      category: 'report',
    })
    return { dutyStatus: 'done', dutyDetail: 'কোনো টাস্ক ছিল না' }
  }

  // Group by staff
  const DONE_STATUSES = new Set(['done', 'done_unverified'])
  const byStaff = {}
  for (const t of allTasks) {
    const staffId = t.agent_staff?.id || t.staff_id
    if (!byStaff[staffId]) byStaff[staffId] = { staff: t.agent_staff, done: [], pending: [] }
    if (DONE_STATUSES.has(t.status)) byStaff[staffId].done.push(t)
    else byStaff[staffId].pending.push(t)
  }

  const reportLines = []
  const tasksToCarry = []
  const compactParts = []
  const byStaffList = []

  for (const { staff, done, pending } of Object.values(byStaff)) {
    const staffId = staff?.id
    const staffName = staff?.name || 'অজানা'
    const workPending = pending.filter((t) => t.type !== 'learning')
    const learningPending = pending.filter((t) => t.type === 'learning')
    const workDone = done.filter((t) => t.type !== 'learning')
    const learningDone = done.filter((t) => t.type === 'learning')
    const workTotal = workDone.length + workPending.length
    const pct = workTotal > 0 ? Math.round((workDone.length / workTotal) * 100) : 0
    const shortName = staffName.split(' ').pop() ?? staffName
    compactParts.push(`${shortName} ${bnNum(workDone.length)}/${bnNum(workTotal)} সম্পন্ন`)

    byStaffList.push({ staff, done, pending })

    let lunchLine = ''
    const lunch = lunchByStaff[staffId]
    if (lunch) {
      if (lunch.ended_at && lunch.duration_min != null) {
        if (lunch.duration_min > 45) {
          const extra = lunch.duration_min - 45
          lunchLine = `   🍽 লাঞ্চ ${bnNum(lunch.duration_min)} মিনিট (${bnNum(extra)} মিনিট বেশি)\n`
        } else {
          lunchLine = `   🍽 লাঞ্চ ${bnNum(lunch.duration_min)} মিনিট ✅\n`
        }
      } else {
        const openMins = Math.round((Date.now() - new Date(lunch.started_at).getTime()) / 60000)
        lunchLine = `   🍽 লাঞ্চে — ${bnNum(openMins)} মিনিট, এখনো ফেরেনি ⚠️\n`
      }
      if ((overrunCountByStaff[staffId] ?? 0) >= 2) {
        lunchLine += `   ⚠️ গত ৭ দিনে বারবার লাঞ্চ বেশি — নজর দরকার\n`
      }
    }

    reportLines.push(
      `👤 *${staffName}*: ${workDone.length}/${workTotal} (${pct}%)` +
      (learningDone.length + learningPending.length > 0
        ? ` · 📚 শেখা ${learningDone.length}/${learningDone.length + learningPending.length}`
        : '') +
      `\n` +
      lunchLine +
      (workDone.length > 0 ? `   ✅ ${workDone.map(t => t.title).join(', ')}\n` : '') +
      (workPending.length > 0 ? `   ⏳ ${workPending.map(t => t.title).join(', ')}\n` : '') +
      (learningPending.length > 0 ? `   📚 (ঐচ্ছিক) ${learningPending.map(t => t.title).join(', ')}` : '') +
      (learningDone.length > 0 && learningPending.length === 0 ? `   📚 ✅ ${learningDone.map(t => t.title).join(', ')}` : ''),
    )

    // Carry incomplete work tasks only — learning tasks are optional growth
    if (workPending.length > 0) {
      tasksToCarry.push(...workPending)
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
      type:         normalizeStaffTaskType(t.type),
      product_ref:  t.product_ref ?? null,
      status:       'proposed',
      proposed_for: tomorrowStr,
      source: normalizeStaffTaskSource('carry_forward'),
      business_id:  t.business_id ?? t.agent_staff?.business_id ?? 'ALMA_LIFESTYLE',
      created_at:   new Date().toISOString(),
    }))

    const { error: carryErr } = await supabase.from('staff_tasks').insert(carryData)
    if (carryErr) {
      console.error(`[night-report] carry-forward insert failed:`, carryErr.message)
    } else {
      console.log(`[night-report] carried ${tasksToCarry.length} tasks → ${tomorrowStr} as proposed`)
    }
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
  } catch (err) {
    console.warn('[night-report] salah summary failed:', err?.message ?? err)
  }

  // Today's sales snapshot (best-effort)
  let salesSummary = ''
  try {
    const salesRes = await fetch(`${getAppUrl()}/api/assistant/internal/agent-settings?keys=today_sales_summary`, {
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(15_000),
    })
    const data = await salesRes.json()
    if (data.today_sales_summary) salesSummary = `\n\n📊 ${data.today_sales_summary}`
  } catch (err) {
    console.warn('[night-report] sales summary failed:', err?.message ?? err)
  }

  // Reply-time stats (Phase 10)
  let replySummary = ''
  try {
    const replyStats = await aggregateReplyStats(supabase, today)
    if (replyStats.length > 0) {
      replySummary = '\n\n💬 *Messenger reply time:*\n' +
        replyStats.map((s) => `• ${s.name} গড় reply: ${s.avgMinutes} মিনিট (${s.count}টি)`).join('\n')
    }
  } catch (err) {
    console.warn('[night-report] reply stats failed:', err?.message ?? err)
  }

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
  } catch (err) {
    console.warn('[night-report] GPS gap check failed:', err?.message ?? err)
  }

  let csSummary = ''
  try {
    const csRes = await fetch(`${getAppUrl()}/api/assistant/internal/cs-analytics?days=1`, {
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (csRes.ok) {
      const csData = await csRes.json()
      if (csData.formatted) csSummary = `\n\n${csData.formatted}`
    }
  } catch (err) {
    console.warn('[night-report] CS analytics failed:', err?.message ?? err)
  }

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
  } catch (err) {
    console.warn('[night-report] AI cost summary failed:', err?.message ?? err)
  }

  let patternSummary = ''
  try {
    const { detectStaffPatterns } = await import('./pattern-detect.mjs')
    const flags = await detectStaffPatterns({ supabase })
    if (flags.length) {
      patternSummary =
        '\n\n⚠️ *প্যাটার্ন সতর্কতা (৭ দিন):*\n' +
        flags.map((f) => `• ${f.name}: ${f.detail}`).join('\n')
    }
  } catch (err) {
    console.warn('[night-report] pattern detection failed:', err?.message ?? err)
  }

  const dateLabel = formatDhakaDateLabel(today)
  const carryLine = tasksToCarry.length > 0
    ? `, ${bnNum(tasksToCarry.length)}টি carry-forward`
    : ''
  const compactHeader = `আজকের (${dateLabel}) রিপোর্ট: ${compactParts.join(', ')}${carryLine}`

  let scoreboardBlock = ''
  try {
    const { buildDailyScoreboard, sendScoreboardToStaff } = await import('./scoreboard.mjs')
    const scoreboard = await buildDailyScoreboard(supabase, today, byStaffList)
    scoreboardBlock = scoreboard.ownerBlock ? `${scoreboard.ownerBlock}\n\n` : ''
    const staffSent = await sendScoreboardToStaff({ supabase, bot, perStaff: scoreboard.perStaff })
    if (staffSent) console.log(`[night-report] scoreboard sent to ${staffSent} staff`)
  } catch (err) {
    console.warn('[night-report] scoreboard failed:', err?.message ?? err)
  }

  const reportText =
    `📋 *${compactHeader}*\n\n` +
    scoreboardBlock +
    reportLines.join('\n\n') +
    salahSummary +
    salesSummary +
    replySummary +
    csSummary +
    aiCostSummary +
    gpsGapLine +
    patternSummary +
    (tasksToCarry.length > 0 ? `\n\n↩ ${tasksToCarry.length}টি কাজ আগামীকালের জন্য নিয়ে যাওয়া হয়েছে।` : '')

  await notify({
    tier:     1,
    title:    'রাতের রিপোর্ট',
    message:  reportText,
    category: 'report',
    voice:    true,
  })

  const staffCount = Object.keys(byStaff).length
  const doneCount = allTasks.filter(t => t.status === 'done').length
  console.log(`[night-report] sent for ${today} — ${allTasks.length} tasks, ${tasksToCarry.length} carried`)
  return {
    dutyStatus: 'done',
    dutyDetail: `${staffCount} স্টাফ, ${doneCount}/${allTasks.length} সম্পন্ন, ${tasksToCarry.length} carry`,
  }
}
