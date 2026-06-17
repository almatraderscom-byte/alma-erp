/**
 * Weekly agent scorecard — aggregates AgentToolEvent data and sends a Telegram digest.
 * Runs Saturday 09:30 Dhaka (cronUtc: '30 3 * * 6').
 */
import { notify } from '../notify/index.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runAgentScorecard() {
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/tool-scorecard`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${INT_TOKEN()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ days: 7 }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      console.warn(`[agent-scorecard] HTTP ${res.status}`)
      return { dutyStatus: 'error', dutyDetail: `API error: HTTP ${res.status}` }
    }

    const data = await res.json()

    const lines = [
      '📊 *Weekly Agent Tool Scorecard*',
      `📅 গত ৭ দিন`,
      '',
      `🔧 Total calls: ${data.totalCalls}`,
      `❌ Failures: ${data.failCount} (${data.failRate}%)`,
      `✅ Verified writes: ${data.verifiedCount} (${data.verifiedRate}%)`,
      `🚫 Refusals (maybe starved): ${data.refusalCount}`,
      `⏱️ P95 latency: ${data.p95LatencyMs}ms`,
    ]

    if (data.topErrors?.length > 0) {
      lines.push('', '*Top Errors:*')
      for (const e of data.topErrors.slice(0, 5)) {
        lines.push(`  • ${e.errorClass}: ${e.count}`)
      }
    }

    if (data.perTool?.length > 0) {
      lines.push('', '*Top Tools (by calls):*')
      for (const t of data.perTool.slice(0, 10)) {
        const failPct = t.calls > 0 ? Math.round((t.fails / t.calls) * 100) : 0
        lines.push(`  • ${t.toolName}: ${t.calls} calls, ${failPct}% fail, avg ${t.avgLatencyMs}ms`)
      }
    }

    const msg = lines.join('\n')
    await notify({
      tier: 3,
      title: 'Agent Weekly Scorecard',
      message: msg,
      category: 'report',
    })

    console.log('[agent-scorecard] sent digest')
    return { dutyStatus: 'done', dutyDetail: `${data.totalCalls} calls, ${data.failRate}% fail rate` }
  } catch (err) {
    console.error('[agent-scorecard] failed:', err.message)
    return { dutyStatus: 'error', dutyDetail: `Scorecard ব্যর্থ: ${err.message?.slice(0, 40)}` }
  }
}
