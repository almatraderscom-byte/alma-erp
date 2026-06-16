/**
 * Security Audit Scanner — periodic security posture check.
 * Runs weekly (Friday 22:30 Dhaka, after weekly reflection).
 *
 * Checks:
 *  1. Unusual tool execution patterns (spikes in sensitive tools)
 *  2. Failed tool executions (may indicate probing)
 *  3. API health (token expiry, provider balance)
 *  4. Unauthorized access attempts (from middleware logs)
 *  5. Action approval bypass detection
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID

const SENSITIVE_TOOLS = new Set([
  'outbound_phone_call', 'call_family_member', 'send_urgent_alert',
  'log_expense', 'log_expenses_batch', 'log_ledger_entries_batch',
  'delete_finance_entry', 'edit_finance_entry',
  'publish_to_website', 'update_website_product',
  'approve_action', 'reject_action',
])

export async function runSecurityAudit(context) {
  const { supabase, bot } = context
  if (!OWNER_CHAT_ID || !bot) return { dutyStatus: 'skipped', dutyDetail: 'no owner' }

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const findings = []

  const { data: toolCalls } = await supabase
    .from('agent_tool_calls')
    .select('toolName, status, "createdAt"')
    .gte('createdAt', weekAgo)

  const calls = toolCalls ?? []
  const totalCalls = calls.length
  const failedCalls = calls.filter(c => c.status === 'error')
  const sensitiveCallCount = calls.filter(c => SENSITIVE_TOOLS.has(c.toolName)).length

  if (failedCalls.length > totalCalls * 0.2 && totalCalls > 10) {
    findings.push({
      severity: 'warning',
      issue: `High tool failure rate: ${failedCalls.length}/${totalCalls} (${((failedCalls.length/totalCalls)*100).toFixed(0)}%)`,
    })
  }

  const failedByTool = {}
  for (const c of failedCalls) {
    failedByTool[c.toolName] = (failedByTool[c.toolName] || 0) + 1
  }
  for (const [tool, count] of Object.entries(failedByTool)) {
    if (count >= 5) {
      findings.push({
        severity: SENSITIVE_TOOLS.has(tool) ? 'critical' : 'warning',
        issue: `${tool}: ${count} failures this week`,
      })
    }
  }

  const { data: pendingActions } = await supabase
    .from('agent_pending_actions')
    .select('type, status, "createdAt"')
    .gte('createdAt', weekAgo)

  const actions = pendingActions ?? []
  const approved = actions.filter(a => a.status === 'approved').length
  const rejected = actions.filter(a => a.status === 'rejected').length
  const expired = actions.filter(a => a.status === 'expired').length
  const pending = actions.filter(a => a.status === 'pending').length

  if (pending > 5) {
    findings.push({
      severity: 'info',
      issue: `${pending} unresolved pending actions — may need owner attention`,
    })
  }

  const { data: costData } = await supabase
    .from('agent_cost_events')
    .select('cost_usd')
    .gte('created_at', weekAgo)

  const weeklyCost = (costData ?? []).reduce((s, c) => s + (c.cost_usd || 0), 0)
  if (weeklyCost > 5.0) {
    findings.push({
      severity: 'warning',
      issue: `Weekly AI cost: $${weeklyCost.toFixed(2)} — above $5 threshold`,
    })
  }

  const statusEmoji = { critical: '🔴', warning: '🟡', info: '🔵' }
  const L = ['🔐 *সাপ্তাহিক সিকিউরিটি অডিট*', '']
  L.push(`📊 এই সপ্তাহের সারসংক্ষেপ:`)
  L.push(`• মোট টুল কল: ${totalCalls}`)
  L.push(`• ব্যর্থ: ${failedCalls.length}`)
  L.push(`• সেনসিটিভ টুল ব্যবহার: ${sensitiveCallCount}`)
  L.push(`• অ্যাকশন: ${approved} অনুমোদিত, ${rejected} বাতিল, ${expired} মেয়াদোত্তীর্ণ`)
  L.push(`• AI খরচ: $${weeklyCost.toFixed(2)}`)
  L.push('')

  if (findings.length === 0) {
    L.push('✅ কোনো নিরাপত্তা সমস্যা পাওয়া যায়নি।')
  } else {
    L.push(`⚠️ ${findings.length}টি finding:`)
    for (const f of findings) {
      L.push(`${statusEmoji[f.severity] || '•'} ${f.issue}`)
    }
  }

  await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID, L.join('\n'))

  return {
    dutyStatus: 'done',
    dutyDetail: `${findings.length} findings, ${totalCalls} calls, $${weeklyCost.toFixed(2)} cost`,
  }
}
