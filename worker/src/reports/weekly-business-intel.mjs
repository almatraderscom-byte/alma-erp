/**
 * Weekly Business Intelligence Report — comprehensive automated analysis.
 * Runs every Saturday at 09:00 Dhaka (alongside marketing-weekly).
 *
 * Covers:
 *  1. Revenue trend (week-over-week, month-over-month)
 *  2. Top products by revenue + top growing products
 *  3. Order funnel: placed → confirmed → delivered → returned
 *  4. Customer acquisition vs repeat
 *  5. Anomaly detection (sudden drops/spikes)
 *  6. AI cost tracking summary
 *  7. Staff productivity score comparison
 */
import Anthropic from '@anthropic-ai/sdk'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { logCost } from '../cost-log.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID

function dhakaYmd(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export async function runWeeklyBusinessIntel(context) {
  const { supabase, bot } = context
  if (!OWNER_CHAT_ID || !bot) return { dutyStatus: 'skipped', dutyDetail: 'no owner chat' }

  const thisWeekStart = dhakaYmd(6)
  const thisWeekEnd = dhakaYmd(0)
  const lastWeekStart = dhakaYmd(13)
  const lastWeekEnd = dhakaYmd(7)

  const [thisWeekOrders, lastWeekOrders, aiCosts, staffScores] = await Promise.all([
    supabase.from('lifestyle_orders')
      .select('id, status, total_amount, date, product_code, customer')
      .gte('date', thisWeekStart).lte('date', thisWeekEnd),
    supabase.from('lifestyle_orders')
      .select('id, status, total_amount, date, product_code, customer')
      .gte('date', lastWeekStart).lte('date', lastWeekEnd),
    supabase.from('agent_cost_log')
      .select('provider, cost_usd, created_at')
      .gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString()),
    supabase.from('agent_kv_settings')
      .select('value')
      .eq('key', 'staff_performance_scores')
      .maybeSingle(),
  ])

  const tw = thisWeekOrders?.data ?? []
  const lw = lastWeekOrders?.data ?? []

  const twRevenue = tw.filter(o => o.status !== 'Cancelled' && o.status !== 'Refunded')
    .reduce((s, o) => s + (o.total_amount || 0), 0)
  const lwRevenue = lw.filter(o => o.status !== 'Cancelled' && o.status !== 'Refunded')
    .reduce((s, o) => s + (o.total_amount || 0), 0)
  const revenueChange = lwRevenue > 0 ? ((twRevenue - lwRevenue) / lwRevenue * 100).toFixed(1) : 'N/A'

  const twOrders = tw.length
  const lwOrders = lw.length
  const orderChange = lwOrders > 0 ? ((twOrders - lwOrders) / lwOrders * 100).toFixed(1) : 'N/A'

  const twDelivered = tw.filter(o => o.status === 'Delivered').length
  const twCancelled = tw.filter(o => o.status === 'Cancelled').length
  const twReturned = tw.filter(o => o.status === 'Refunded').length
  const twPending = tw.filter(o => o.status === 'Pending').length

  const productRevenue = {}
  for (const o of tw.filter(o => o.status !== 'Cancelled' && o.status !== 'Refunded')) {
    const code = o.product_code || 'unknown'
    productRevenue[code] = (productRevenue[code] || 0) + (o.total_amount || 0)
  }
  const topProducts = Object.entries(productRevenue)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([code, rev]) => `${code}: ৳${rev}`)

  const uniqueCustomers = new Set(tw.map(o => o.customer?.trim()?.toLowerCase()).filter(Boolean))
  const lastWeekCustomers = new Set(lw.map(o => o.customer?.trim()?.toLowerCase()).filter(Boolean))
  const newCustomers = [...uniqueCustomers].filter(c => !lastWeekCustomers.has(c)).length
  const repeatCustomers = [...uniqueCustomers].filter(c => lastWeekCustomers.has(c)).length

  const totalAiCost = (aiCosts?.data ?? []).reduce((s, c) => s + (c.cost_usd || 0), 0)
  const aiByProvider = {}
  for (const c of aiCosts?.data ?? []) {
    aiByProvider[c.provider] = (aiByProvider[c.provider] || 0) + (c.cost_usd || 0)
  }

  let scores = null
  try { scores = JSON.parse(staffScores?.data?.value ?? 'null') } catch {}

  const dataContext = [
    `Period: ${thisWeekStart} to ${thisWeekEnd}`,
    `Revenue: ৳${twRevenue} (${revenueChange}% vs last week ৳${lwRevenue})`,
    `Orders: ${twOrders} (${orderChange}% change)`,
    `Funnel: Delivered ${twDelivered}, Cancelled ${twCancelled}, Returned ${twReturned}, Pending ${twPending}`,
    `Top products: ${topProducts.join(', ')}`,
    `Customers: ${uniqueCustomers.size} unique (${newCustomers} new, ${repeatCustomers} repeat)`,
    `AI cost this week: $${totalAiCost.toFixed(2)} — ${Object.entries(aiByProvider).map(([k, v]) => `${k}: $${v.toFixed(2)}`).join(', ')}`,
    scores ? `Staff scores: ${JSON.stringify(scores).slice(0, 200)}` : '',
  ].filter(Boolean).join('\n')

  const anomalies = []
  if (Number(revenueChange) < -30) anomalies.push(`Revenue dropped ${revenueChange}%`)
  if (Number(revenueChange) > 50) anomalies.push(`Revenue spiked ${revenueChange}%`)
  if (twCancelled > twOrders * 0.25) anomalies.push(`High cancellation rate: ${((twCancelled/twOrders)*100).toFixed(0)}%`)
  if (twReturned > twOrders * 0.15) anomalies.push(`High return rate: ${((twReturned/twOrders)*100).toFixed(0)}%`)

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are a business intelligence analyst for a Bangladeshi e-commerce clothing brand (Alma Lifestyle). Generate a weekly business report in Bangla. Be concise, use bullet points and emojis. Highlight anomalies if any.

DATA:
${dataContext}
${anomalies.length ? `\nANOMALIES: ${anomalies.join(', ')}` : ''}

Format: Sections with emoji headers. Key metrics first, then insights. End with 2-3 action items for next week. All in Bangla.`,
    }],
  })

  const report = response.content[0]?.type === 'text' ? response.content[0].text : ''
  if (!report) return { dutyStatus: 'failed', dutyDetail: 'AI returned empty report' }

  void logCost({
    provider: 'anthropic',
    kind: 'chat',
    units: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens },
    costUsd: ((response.usage?.input_tokens ?? 0) * 3 + (response.usage?.output_tokens ?? 0) * 15) / 1_000_000,
    dedupKey: `weekly-biz-intel:${thisWeekEnd}`,
  })

  const msg = `📊 *সাপ্তাহিক বিজনেস ইন্টেলিজেন্স*\n${thisWeekStart} → ${thisWeekEnd}\n\n${report}`
  await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID, msg)

  return {
    dutyStatus: 'done',
    dutyDetail: `Report sent: ৳${twRevenue} revenue, ${twOrders} orders, ${revenueChange}% change`,
  }
}
