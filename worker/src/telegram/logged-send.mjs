import { createClient } from '@supabase/supabase-js'
import { sendMarkdownSafe } from './markdown-safe.mjs'
import { prepareStaffOutboundMessage } from '../staff/alma-team-voice.mjs'
import { compactUuid, msgAckCallbackData } from './callback-data.mjs'
import { isWithinOfficeHours } from '../staff/office-hours.mjs'

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Sends a Telegram message to staff AND logs it to agent_outbox with delivery status.
 * @returns {Promise<{ ok: boolean, messageId?: number, outboxId?: string, error?: string }>}
 */
export async function loggedSendToStaff(telegram, {
  supabase: extSupabase,
  staffId,
  staffName,
  businessId,
  type,
  content,
  chatId,
  relatedTaskIds,
  extra,
  requiresAck = false,
  officeHoursOnly = false,
}) {
  const supabase = extSupabase ?? sb()
  const biz = businessId ?? 'ALMA_LIFESTYLE'

  if (officeHoursOnly && !isWithinOfficeHours(biz)) {
    const outboxId = crypto.randomUUID()
    const shortId = compactUuid(outboxId)
    await supabase.from('agent_outbox').insert({
      id: outboxId,
      short_id: shortId,
      staff_id: staffId ?? null,
      staff_name: staffName ?? null,
      business_id: biz,
      type,
      content: prepareStaffOutboundMessage(content),
      status: 'skipped_offhours',
      related_task_ids: relatedTaskIds ?? null,
      requires_ack: requiresAck,
      error_reason: 'outside office hours',
      created_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
    }).catch((err) => console.warn('[logged-send] offhours skip log failed:', err.message))
    return { ok: false, skipped: true, outboxId }
  }

  const outboxId = crypto.randomUUID()
  const shortId = compactUuid(outboxId)
  const safeContent = prepareStaffOutboundMessage(content)

  const { error: insertErr } = await supabase.from('agent_outbox').insert({
    id: outboxId,
    short_id: shortId,
    staff_id: staffId ?? null,
    staff_name: staffName ?? null,
    business_id: businessId ?? null,
    type,
    content: safeContent,
    status: 'queued',
    related_task_ids: relatedTaskIds ?? null,
    requires_ack: requiresAck,
    created_at: new Date().toISOString(),
  })

  if (insertErr) {
    console.warn('[logged-send] outbox insert failed:', insertErr.message)
  }

  if (!chatId) {
    if (!insertErr) {
      await supabase.from('agent_outbox').update({
        status: 'failed',
        error_reason: 'no telegram chatId',
        sent_at: new Date().toISOString(),
      }).eq('id', outboxId)
    }
    return { ok: false, outboxId, error: 'no_chat_id' }
  }

  let replyMarkup = extra?.reply_markup
  if (requiresAck && outboxId) {
    const ackBtn = { text: '👀 দেখেছি', callback_data: msgAckCallbackData(outboxId) }
    const existing = replyMarkup?.inline_keyboard ?? []
    replyMarkup = { inline_keyboard: [...existing, [ackBtn]] }
    if (!insertErr) {
      await supabase.from('agent_outbox').update({ requires_ack: true }).eq('id', outboxId)
    }
  }

  const sendExtra = { ...(extra ?? {}), ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }

  try {
    const sent = await sendMarkdownSafe(telegram, chatId, safeContent, sendExtra)
    if (!insertErr) {
      await supabase.from('agent_outbox').update({
        status: 'delivered',
        telegram_message_id: String(sent.message_id),
        sent_at: new Date().toISOString(),
      }).eq('id', outboxId)
    }
    return { ok: true, messageId: sent.message_id, outboxId }
  } catch (err) {
    const reason = err?.message?.slice(0, 300) ?? 'send error'
    if (!insertErr) {
      await supabase.from('agent_outbox').update({
        status: 'failed',
        error_reason: reason,
        sent_at: new Date().toISOString(),
      }).eq('id', outboxId)
    }
    return { ok: false, outboxId, error: reason }
  }
}
