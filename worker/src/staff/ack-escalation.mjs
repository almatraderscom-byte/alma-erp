/**
 * Escalate staff messages that required acknowledgement but were not seen within 10 minutes.
 * Owner alerts fire anytime; staff NTFY fires anytime (office hours only limits Telegram re-ping).
 */
import { sendNtfy, sendNtfyToTopic } from '../notify/ntfy.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { isWithinOfficeHours } from './office-hours.mjs'
import { isStaffOnLeaveSb, dhakaToday } from './leave.mjs'

async function recordAckEscalationRun(supabase) {
  const at = new Date().toISOString()
  try {
    const { error } = await supabase.from('agent_kv_settings').upsert({
      key: 'scheduler:last_run:ack-escalation',
      value: JSON.stringify({ at }),
      updated_at: at,
    })
    if (error) console.warn('[ack-escalation] last-run log failed:', error.message)
  } catch (err) {
    console.warn('[ack-escalation] last-run log failed:', err.message)
  }
}

/**
 * @param {object} params
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabase
 * @param {import('telegraf').Telegraf} params.bot
 */
export async function runAckEscalation({ supabase, bot }) {
  await recordAckEscalationRun(supabase)

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) {
    console.error('[ack-escalation] BLOCKED — TELEGRAM_OWNER_CHAT_ID or bot missing')
    await sendNtfy(
      'critical',
      'Ack escalation broken',
      'TELEGRAM_OWNER_CHAT_ID/bot missing — staff unseen alerts not running',
      'urgent',
    ).catch(() => {})
    return { ok: false, reason: 'missing_owner_chat' }
  }

  const duringOffice = isWithinOfficeHours('ALMA_LIFESTYLE')
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data: unseen, error } = await supabase
    .from('agent_outbox')
    .select('id, staff_id, staff_name, content, sent_at')
    .eq('requires_ack', true)
    .eq('status', 'delivered')
    .is('acknowledged_at', null)
    .is('ack_escalated_at', null)
    .lt('sent_at', tenMinAgo)

  if (error) {
    console.warn('[ack-escalation] query failed:', error.message)
    await sendNtfy('critical', 'Ack escalation query failed', error.message, 'urgent').catch(() => {})
    return { ok: false, reason: 'query_failed' }
  }
  if (!unseen?.length) return { ok: true, escalated: 0 }

  console.log(`[ack-escalation] escalating ${unseen.length} unseen message(s) (office=${duringOffice})`)

  for (const m of unseen) {
    const preview = (m.content ?? '').slice(0, 80)
    await sendMarkdownSafe(
      bot.telegram,
      ownerChatId,
      `🔴 ${m.staff_name ?? 'স্টাফ'} ১০ মিনিটেও মেসেজ দেখেনি:\n"${preview}"`,
    ).catch(() => {})
    await sendNtfy('critical', 'Staff unseen message', `${m.staff_name ?? 'Staff'} 10 min e dekheni`, 'urgent').catch(() => {})

    const today = dhakaToday()
    const onLeave = m.staff_id && (await isStaffOnLeaveSb(supabase, m.staff_id, today))
    if (!onLeave && m.staff_id) {
      const { data: staff } = await supabase
        .from('agent_staff')
        .select('telegramChatId, ntfyTopic, name')
        .eq('id', m.staff_id)
        .maybeSingle()

      if (staff?.ntfyTopic) {
        await sendNtfyToTopic(
          staff.ntfyTopic,
          'নতুন কাজ',
          `${staff.name}, একটি মেসেজ অপেক্ষা করছে — দেখুন।`,
          'task',
        ).catch(() => {})
      }
      if (duringOffice && staff?.telegramChatId) {
        await sendMarkdownSafe(
          bot.telegram,
          staff.telegramChatId,
          `⏰ ${staff.name} ভাই, একটি মেসেজ এখনো দেখেননি — দয়া করে দেখে "👀 দেখেছি" চাপুন।`,
        ).catch(() => {})
      }
    }

    await supabase
      .from('agent_outbox')
      .update({ ack_escalated_at: new Date().toISOString() })
      .eq('id', m.id)
  }

  return { ok: true, escalated: unseen.length }
}
