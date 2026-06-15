/**
 * Error Collector — scheduled duty that scans for production issues
 * and creates auto-fix requests for owner approval.
 *
 * Sources:
 * 1. Vercel alerts (via webhook → stored in KV)
 * 2. Health scan (failed/missed duties, heartbeat issues)
 * 3. Recent Vercel function errors (via Vercel API if configured)
 */
import { createClient } from '@supabase/supabase-js'
import { requestAutoFix } from './dispatch.mjs'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export async function runErrorCollector() {
  const supabase = sb()
  const issues = []
  let detail = ''

  // 1. Check for unprocessed Vercel alerts
  try {
    const { data: alerts } = await supabase
      .from('agent_kv_settings')
      .select('key, value')
      .like('key', 'vercel.alert.%')
      .order('key', { ascending: false })
      .limit(10)

    for (const alert of (alerts ?? [])) {
      try {
        const parsed = JSON.parse(alert.value)
        if (parsed.processed) continue

        issues.push({
          title: `Vercel Alert: ${parsed.title ?? 'Error anomaly'}`,
          area: 'vercel',
          severity: parsed.severity ?? 'high',
          detail: parsed.detail ?? `${parsed.count ?? '?'} errors detected on ${parsed.route ?? 'unknown route'}`,
          signal: `vercel_alert key=${alert.key}`,
          source: 'vercel_alert',
          alertKey: alert.key,
        })

        await supabase.from('agent_kv_settings').update({
          value: JSON.stringify({ ...parsed, processed: true, processedAt: new Date().toISOString() }),
        }).eq('key', alert.key)
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    console.warn('[error-collector] KV alert check failed:', err.message)
  }

  // 2. Check health scan results via API
  try {
    const res = await fetch(`${APP_URL}/api/agent/health-scan`, {
      headers: { Authorization: `Bearer ${INT_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const scan = await res.json()
      if (!scan.ok) {
        for (const issue of scan.issues) {
          if (issue.severity !== 'high') continue

          const alreadyPending = await supabase
            .from('agent_pending_actions')
            .select('id')
            .eq('type', 'auto_fix')
            .in('status', ['pending', 'in_progress'])
            .contains('payload', { signal: issue.signal })
            .limit(1)

          if (alreadyPending.data?.length) continue

          issues.push({
            ...issue,
            source: 'health_scan',
          })
        }
      }
    }
  } catch (err) {
    console.warn('[error-collector] health scan API failed:', err.message)
  }

  // 3. Check for recent duty failures not yet addressed
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    const { data: failures } = await supabase
      .from('agent_duty_log')
      .select('duty, label, detail, status')
      .eq('duty_date', today)
      .in('status', ['failed'])

    for (const f of (failures ?? [])) {
      const signal = `duty_failed:${f.duty}:${today}`
      const alreadyPending = await supabase
        .from('agent_pending_actions')
        .select('id')
        .eq('type', 'auto_fix')
        .in('status', ['pending', 'in_progress'])
        .contains('payload', { signal })
        .limit(1)

      if (alreadyPending.data?.length) continue

      issues.push({
        title: `ডিউটি ব্যর্থ: ${f.label ?? f.duty}`,
        area: 'scheduler',
        severity: 'high',
        detail: f.detail ?? 'No details available',
        signal,
        source: 'duty_failure',
      })
    }
  } catch (err) {
    console.warn('[error-collector] duty check failed:', err.message)
  }

  // Rate limit: max 3 auto-fix requests per hour
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: recentCount } = await supabase
    .from('agent_pending_actions')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'auto_fix')
    .gte('created_at', hourAgo)

  if ((recentCount ?? 0) >= 3) {
    detail = `Rate limited: ${issues.length} issues found but already 3+ requests this hour`
    return { dutyStatus: 'done', dutyDetail: detail }
  }

  // Deduplicate by signal: skip issues that already have a pending/in-progress fix
  const newIssues = []
  for (const issue of issues) {
    if (issue.signal) {
      const { data: existing } = await supabase
        .from('agent_pending_actions')
        .select('id')
        .eq('type', 'auto_fix')
        .in('status', ['pending', 'in_progress', 'approved'])
        .like('summary', `%${issue.signal.slice(0, 60)}%`)
        .limit(1)

      if (existing?.length) continue
    }
    newIssues.push(issue)
  }

  // Create auto-fix requests for each new issue
  let requested = 0
  for (const issue of newIssues) {
    try {
      await requestAutoFix(issue)
      requested++
    } catch (err) {
      console.warn('[error-collector] requestAutoFix failed:', err.message)
    }
  }

  detail = detail || `Scanned: ${issues.length} issues, ${requested} auto-fix requests created`
  console.log(`[error-collector] ${detail}`)

  return {
    dutyStatus: requested > 0 ? 'done' : 'done',
    dutyDetail: detail,
  }
}
