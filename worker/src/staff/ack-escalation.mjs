/**
 * Escalate staff messages that required acknowledgement but were not seen within 10 minutes.
 */
import { sendNtfy, sendNtfyToTopic } from '../notify/ntfy.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

/**
 * @param {object} params
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabase
 * @param {import('telegraf').Telegraf} params.bot
 */
export async function runAckEscalation({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) return

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
    return
  }
  if (!unseen?.length) return

  console.log(`[ack-escalation] escalating ${unseen.length} unseen message(s)`)

  for (const m of unseen) {
    const preview = (m.content ?? '').slice(0, 80)
    await sendMarkdownSafe(
      bot.telegram,
      ownerChatId,
      `🔴 ${m.staff_name ?? 'স্টাফ'} ১০ মিনিটেও মেসেজ দেখেনি:\n"${preview}"`,
    ).catch(() => {})
    await sendNtfy('critical', 'Staff unseen message', `${m.staff_name ?? 'Staff'} 10 min e dekheni`, 'urgent').catch(() => {})

    const { data: staff } = await supabase
      .from('agent_staff')
      .select('telegramChatId, ntfyTopic, name')
      .eq('id', m.staff_id)
      .maybeSingle()

    if (staff?.ntfyTopic) {
      await sendNtfyToTopic(
        staff.ntfyTopic,
        'নতুন কাজ',
        `${staff.name}, একটি কাজ অপেক্ষা করছে — দেখুন।`,
        'task',
      ).catch(() => {})
    }
    if (staff?.telegramChatId) {
      await sendMarkdownSafe(
        bot.telegram,
        staff.telegramChatId,
        `⏰ ${staff.name} ভাই, একটি মেসেজ এখনো দেখেননি — দয়া করে দেখে "👀 দেখেছি" চাপুন।`,
      ).catch(() => {})
    }

    await supabase
      .from('agent_outbox')
      .update({ ack_escalated_at: new Date().toISOString() })
      .eq('id', m.id)
  }
}
