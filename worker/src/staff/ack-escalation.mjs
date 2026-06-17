/**
 * Escalate staff messages that required acknowledgement — staff nudge ×2, then owner (Phase 3).
 */
import { sendNtfy } from '../notify/ntfy.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { isWithinOfficeHours } from './office-hours.mjs'
import {
  MAX_STAFF_NUDGES,
  formatOwnerEscalation,
  sendOwnerEscalation,
} from './task-nudge.mjs'

const NUDGE1_MS = 10 * 60 * 1000
const NUDGE2_MS = 20 * 60 * 1000
const ESCALATE_MS = 30 * 60 * 1000

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

async function getAckNudgeCount(supabase, outboxId) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', `ack_nudge:${outboxId}`)
    .maybeSingle()
  if (!data?.value) return 0
  if (typeof data.value === 'number') return data.value
  if (typeof data.value === 'object' && data.value != null) return Number(data.value.count ?? 0)
  try {
    const parsed = JSON.parse(String(data.value))
    return Number(parsed.count ?? 0)
  } catch {
    return 0
  }
}

async function setAckNudgeCount(supabase, outboxId, count) {
  await supabase.from('agent_kv_settings').upsert({
    key: `ack_nudge:${outboxId}`,
    value: { count, at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  })
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
    ).catch((err) => {
      console.warn('[ack-escalation] critical ntfy failed:', err.message)
    })
    return { ok: false, reason: 'missing_owner_chat' }
  }

  const duringOffice = isWithinOfficeHours('ALMA_LIFESTYLE')
  const { data: unseen, error } = await supabase
    .from('agent_outbox')
    .select('id, staff_id, staff_name, content, sent_at')
    .eq('requires_ack', true)
    .eq('status', 'delivered')
    .is('acknowledged_at', null)
    .is('ack_escalated_at', null)
    .not('sent_at', 'is', null)

  if (error) {
    console.warn('[ack-escalation] query failed:', error.message)
    return { ok: false, reason: 'query_failed' }
  }
  if (!unseen?.length) return { ok: true, escalated: 0, nudged: 0 }

  const now = Date.now()
  let nudged = 0
  let escalated = 0

  for (const m of unseen) {
    const sentAt = m.sent_at ? new Date(m.sent_at).getTime() : now
    const elapsed = now - sentAt
    const nudgeCount = await getAckNudgeCount(supabase, m.id)
    let staffName = m.staff_name ?? 'স্টাফ'
    const preview = (m.content ?? '').slice(0, 60)
    let chatId = null
    if (m.staff_id) {
      const { data: staffRow } = await supabase
        .from('agent_staff')
        .select('telegramChatId, name')
        .eq('id', m.staff_id)
        .maybeSingle()
      chatId = staffRow?.telegramChatId
      if (staffRow?.name) staffName = staffRow.name
    }

    if (elapsed >= ESCALATE_MS && nudgeCount >= MAX_STAFF_NUDGES) {
      const line = formatOwnerEscalation({
        staffName,
        title: preview || 'মেসেজ',
        reason: '২টা reminder — মেসেজ দেখেননি',
        recommendation: 'Telegram এ directly call/message করুন।',
      })
      const sent = await sendOwnerEscalation(bot.telegram, ownerChatId, line)
      if (sent) {
        await supabase
          .from('agent_outbox')
          .update({ ack_escalated_at: new Date().toISOString() })
          .eq('id', m.id)
        escalated++
      }
      continue
    }

    if (!duringOffice || !chatId) continue

    const needNudge =
      (elapsed >= NUDGE1_MS && nudgeCount < 1) ||
      (elapsed >= NUDGE2_MS && nudgeCount < 2)

    if (!needNudge || nudgeCount >= MAX_STAFF_NUDGES) continue

    const msg =
      nudgeCount === 0
        ? `⏰ ${staffName} ভাই, একটি মেসেজ দেখেননি — দয়া করে দেখে "👀 দেখেছি" চাপুন।`
        : `⏰ ${staffName} ভাই, এখনো মেসেজটি pending — দয়া করে দেখুন।`

    await sendMarkdownSafe(bot.telegram, chatId, msg).catch((err) => {
      console.warn(`[ack-escalation] staff nudge failed ${staffName}:`, err.message)
    })
    await setAckNudgeCount(supabase, m.id, nudgeCount + 1)
    nudged++
  }

  if (nudged || escalated) {
    console.log(`[ack-escalation] nudged=${nudged} escalated=${escalated}`)
  }

  return { ok: true, nudged, escalated }
}
