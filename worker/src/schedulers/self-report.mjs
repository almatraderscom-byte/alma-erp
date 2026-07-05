/**
 * P5 weekly self-report — the agent's own QA loop, one owner digest per week
 * (roadmap P5: "every failure checkpoint from the week + what was changed to
 * prevent recurrence" + success-rate telemetry + golden-eval regressions).
 *
 * Runs Saturday 11:00 Dhaka. Three parts, one message:
 *   1. GOLDEN EVALS run locally through the real workbench executor — a
 *      regression (missing binary, broken artifact flow, dead network) is
 *      reported BEFORE the owner hits it.
 *   2. The app's /internal/self-report: the week's checkpoints + per-job-type
 *      success rates + below-threshold flags.
 *   3. One Bangla digest via notify (Telegram + ntfy).
 */
import { notify } from '../notify/index.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runWeeklySelfReport() {
  const sections = []
  let regressions = 0

  // 1. Golden evals through the REAL executor (local to this VPS).
  try {
    const { runGoldenEvals } = await import('../workbench/golden-evals.mjs')
    const golden = await runGoldenEvals()
    regressions = golden.failed.length
    if (golden.failed.length === 0) {
      sections.push(`🥇 Golden evals: ${golden.passed.length}/${golden.passed.length} পাস — workbench ঠিক আছে।`)
    } else {
      sections.push(
        `🚨 Golden evals: ${golden.failed.length}টা REGRESSION —\n` +
          golden.failed.map((f) => `  • ${f.id}: ${f.reason}`).join('\n'),
      )
    }
  } catch (err) {
    regressions++
    sections.push(`🚨 Golden evals চালানোই যায়নি: ${err.message}`)
  }

  // 2. The app-side weekly QA report (checkpoints + success telemetry).
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/self-report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${INT_TOKEN()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 7 }),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.ok) {
      const report = await res.json()
      sections.push(report.digestBn ?? '(digest missing)')
      if ((report.flaggedTypes ?? []).length > 0) regressions++
    } else {
      regressions++
      sections.push(`🚨 Self-report API error: HTTP ${res.status}`)
    }
  } catch (err) {
    regressions++
    sections.push(`🚨 Self-report আনা যায়নি: ${err.message}`)
  }

  // 3. One digest. Louder tier when something regressed.
  await notify({
    tier: regressions > 0 ? 2 : 1,
    title: regressions > 0 ? 'Agent QA — নজর দরকার' : 'Agent Weekly QA',
    message: sections.join('\n\n'),
    category: 'report',
  })

  return {
    dutyStatus: regressions > 0 ? 'attention' : 'done',
    dutyDetail: `golden+self-report sent (${regressions} regression signals)`,
  }
}
