/**
 * Staff message approval gate.
 * Stores the proposed message in agent_pending_actions and sends
 * an approval card to the owner. The message is only sent after approval.
 */
import { createClient } from '@supabase/supabase-js'

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

async function checkTrust(domain, actionPattern, businessId) {
  try {
    const res = await fetch(`${process.env.APP_URL}/api/agent/trust-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.AGENT_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ domain, actionPattern, businessId }),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) return await res.json()
    console.warn('[staff-approval-gate] trust-check non-ok:', res.status)
  } catch (err) {
    console.warn('[staff-approval-gate] trust-check failed:', err?.message)
  }
  // Fail CLOSED: when trust API is down, route to manual approval (safer than 'auto').
  // 'approve' tier means: send approval card to owner, do not auto-act.
  return { tier: 'approve', reason: 'trust_check_unavailable' }
}

export async function requireStaffApproval({
  staffId, staffName, businessId, type, content, chatId,
  relatedTaskIds, extra, requiresAck, officeHoursOnly, dutySource,
}) {
  const supabase = sb()
  const id = crypto.randomUUID()
  const biz = businessId ?? 'ALMA_LIFESTYLE'

  const preview = content?.length > 100 ? content.slice(0, 100) + '…' : content

  const trustResult = await checkTrust('staff', `staff_auto_message:${type}`, biz)

  if (trustResult.tier === 'auto') {
    return { pendingActionId: null, queued: false, ok: true, autoApproved: true, tier: 'auto' }
  }

  if (trustResult.tier === 'notify') {
    try {
      const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
      const botToken = process.env.ASSISTANT_BOT_TOKEN
      if (ownerChatId && botToken) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ownerChatId,
            text: `ℹ️ Auto-sent (trusted): ${staffName ?? 'Unknown'} (${type})\n${preview}\n\n✅ Trust tier: notify`,
          }),
        })
      }
    } catch { /* non-fatal */ }
    return { pendingActionId: null, queued: false, ok: true, autoApproved: true, tier: 'notify' }
  }

  const payload = {
    staffId, staffName, businessId: biz,
    type, content, chatId: String(chatId ?? ''),
    relatedTaskIds: relatedTaskIds ?? null,
    extra: extra ?? null,
    requiresAck: requiresAck ?? false,
    officeHoursOnly: officeHoursOnly ?? false,
    dutySource: dutySource ?? null,
    escalationLevel: 0,
  }

  const summary = `📩 স্টাফ মেসেজ (${type})\n👤 ${staffName ?? 'Unknown'}\n\n${preview}`

  await supabase.from('agent_pending_actions').insert({
    id,
    type: 'staff_auto_message',
    payload,
    summary,
    status: 'pending',
    business_id: biz,
    cost_estimate: 0,
  })

  try {
    const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
    const botToken = process.env.ASSISTANT_BOT_TOKEN
    if (ownerChatId && botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ownerChatId,
          text: `📋 Staff Message Approval\n\n👤 ${staffName ?? 'Unknown'} (${type})\n📝 ${preview}\n\n⏰ 10 মিনিটে অনুমোদন না দিলে কল আসবে`,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ অনুমোদন', callback_data: `staff_approve:${id}` },
              { text: '❌ বাতিল', callback_data: `staff_reject:${id}` },
            ]],
          },
        }),
      })
    }
  } catch (err) {
    console.warn('[staff-approval-gate] telegram card failed:', err.message)
  }

  return { pendingActionId: id, queued: true, ok: false }
}
