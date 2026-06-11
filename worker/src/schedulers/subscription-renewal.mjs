/**
 * Daily 10:00 Asia/Dhaka — subscription renewal alerts + auto-advance past dates.
 */
import { notify } from '../notify/index.mjs'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

function addYears(dateStr, years) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d.toISOString().slice(0, 10)
}

export async function runSubscriptionRenewalCheck({ supabase }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const in3 = new Date()
  in3.setDate(in3.getDate() + 3)
  const in3Str = in3.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  const { data: subs, error } = await supabase
    .from('agent_subscriptions')
    .select('*')
    .eq('active', true)

  if (error) {
    console.error('[subscription-renewal] DB error:', error.message)
    return
  }

  for (const sub of subs ?? []) {
    let renewal = String(sub.next_renewal_at).slice(0, 10)

    // Auto-advance if renewal date passed
    while (renewal < today) {
      renewal = sub.billing_cycle === 'yearly'
        ? addYears(renewal, 1)
        : addMonths(renewal, 1)
      await supabase
        .from('agent_subscriptions')
        .update({ next_renewal_at: renewal, updated_at: new Date().toISOString() })
        .eq('id', sub.id)
      console.log(`[subscription-renewal] advanced ${sub.name} → ${renewal}`)
    }

    if (renewal >= today && renewal <= in3Str) {
      const daysLeft = Math.ceil((new Date(renewal + 'T00:00:00+06:00') - new Date(today + 'T00:00:00+06:00')) / 86400000)
      await notify({
        tier: 1,
        title: 'Subscription renewal',
        message: `${sub.name}: ${sub.currency} ${sub.amount} renews in ${daysLeft} day(s) (${renewal})`,
        category: 'urgent',
      })
    }
  }

  console.log('[subscription-renewal] done')
}
