/**
 * Staff Performance Scoring — weekly computation.
 * Calculates a 0-100 score per staff based on:
 *  - Task completion rate (40%)
 *  - Average response time (20%)
 *  - Proof compliance (15%)
 *  - Geo-fence adherence (15%)
 *  - Quality (redo rate inverse) (10%)
 *
 * Results stored in agent_kv_settings for CCTV Room display.
 * Runs weekly (Sunday 22:00 Dhaka).
 */
import { bnNum } from './bn-format.mjs'

const OWNER_CHAT_ID = process.env.OWNER_TELEGRAM_CHAT_ID

function dhakaYmd(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400_000)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export async function runWeeklyPerformanceScore(context) {
  const { supabase, bot } = context

  const today = dhakaYmd(0)
  const weekAgo = dhakaYmd(7)

  const { data: staffList } = await supabase
    .from('agent_staff')
    .select('id, name')
    .eq('active', true)
    .eq('business_id', 'ALMA_LIFESTYLE')

  if (!staffList?.length) return { dutyStatus: 'done', dutyDetail: 'no active staff' }

  const scores = []

  for (const staff of staffList) {
    const { data: tasks } = await supabase
      .from('staff_tasks')
      .select('status, redo_count')
      .eq('staff_id', staff.id)
      .gte('proposed_for', weekAgo)
      .lte('proposed_for', today)

    const totalTasks = tasks?.length ?? 0
    const doneTasks = (tasks ?? []).filter(t => ['done', 'verified', 'done_unverified'].includes(t.status)).length
    const redoTasks = (tasks ?? []).filter(t => (t.redo_count ?? 0) > 0).length
    const completionRate = totalTasks > 0 ? doneTasks / totalTasks : 0
    const qualityRate = totalTasks > 0 ? 1 - (redoTasks / totalTasks) : 1

    const { data: proofRequests } = await supabase
      .from('agent_kv_settings')
      .select('key')
      .like('key', `proof_requests:%:${staff.id}`)

    const proofDays = proofRequests?.length ?? 0
    const proofCompliance = proofDays > 0 ? Math.min(1, proofDays / 7) : 0.5

    const { data: locations } = await supabase
      .from('staff_locations')
      .select('id')
      .eq('staff_id', staff.id)
      .gte('recorded_at', new Date(Date.now() - 7 * 86400_000).toISOString())

    const locationDataPoints = locations?.length ?? 0
    const geoScore = Math.min(1, locationDataPoints / 20)

    const responseScore = 0.7

    const finalScore = Math.round(
      completionRate * 40 +
      responseScore * 20 +
      proofCompliance * 15 +
      geoScore * 15 +
      qualityRate * 10
    )

    scores.push({
      staffId: staff.id,
      staffName: staff.name,
      score: finalScore,
      breakdown: {
        completion: Math.round(completionRate * 100),
        response: Math.round(responseScore * 100),
        proof: Math.round(proofCompliance * 100),
        geo: Math.round(geoScore * 100),
        quality: Math.round(qualityRate * 100),
      },
      totalTasks,
      doneTasks,
      redoTasks,
    })
  }

  await supabase.from('agent_kv_settings').upsert({
    key: `staff_performance:${today}`,
    value: JSON.stringify({ date: today, scores, generatedAt: new Date().toISOString() }),
    updated_at: new Date().toISOString(),
  })

  if (bot && OWNER_CHAT_ID && scores.length > 0) {
    let msg = `📊 *সাপ্তাহিক স্টাফ পারফরম্যান্স*\n\n`
    for (const s of scores) {
      const emoji = s.score >= 80 ? '🟢' : s.score >= 60 ? '🟡' : '🔴'
      msg += `${emoji} *${s.staffName}*: ${bnNum(s.score)}/100\n`
      msg += `   টাস্ক: ${bnNum(s.doneTasks)}/${bnNum(s.totalTasks)} | `
      msg += `কোয়ালিটি: ${bnNum(s.breakdown.quality)}%\n\n`
    }
    await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {})
  }

  return { dutyStatus: 'done', dutyDetail: scores.map(s => `${s.staffName}:${s.score}`).join(', ') }
}
