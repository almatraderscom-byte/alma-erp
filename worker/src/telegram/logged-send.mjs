import { createClient } from '@supabase/supabase-js'
import { sendMarkdownSafe } from './markdown-safe.mjs'
import { prepareStaffOutboundMessage } from '../staff/alma-team-voice.mjs'

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
}) {
  const supabase = extSupabase ?? sb()
  const outboxId = crypto.randomUUID()
  const safeContent = prepareStaffOutboundMessage(content)

  const { error: insertErr } = await supabase.from('agent_outbox').insert({
    id: outboxId,
    staff_id: staffId ?? null,
    staff_name: staffName ?? null,
    business_id: businessId ?? null,
    type,
    content: safeContent,
    status: 'queued',
    related_task_ids: relatedTaskIds ?? null,
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

  try {
    const sent = await sendMarkdownSafe(telegram, chatId, safeContent, extra ?? {})
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
