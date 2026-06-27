import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { buildCallbackData } from '../telegram/callback-data.mjs'
import { isPendingActionExpired } from '../db/pending-action-fields.mjs'

function todayDhaka() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function priorityRank(type) {
  if (/urgent|alert|finance|expense|ledger|delete_finance|edit_finance/i.test(type)) return 0
  if (/dispatch|staff|ads|campaign|bonus/i.test(type)) return 1
  return 2
}

/**
 * Re-surfaces all still-pending approvals as ONE batched, prioritized message.
 */
export async function runApprovalTracker({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) return

  const today = todayDhaka()
  const muteKey = `approvals_muted_${today}`
  const { data: muteRow } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', muteKey)
    .maybeSingle()

  const muted = muteRow?.value === true || muteRow?.value === 'true' || muteRow?.value === '"true"'
  if (muted) {
    console.log('[approval-tracker] muted for today')
    return
  }

  const staleCutoff = new Date(Date.now() - 48 * 3_600_000).toISOString()
  const { data: staleRows } = await supabase
    .from('agent_pending_actions')
    .select('id')
    .eq('status', 'pending')
    .lt('createdAt', staleCutoff)

  if (staleRows?.length) {
    await supabase
      .from('agent_pending_actions')
      .update({ status: 'expired', resolvedAt: new Date().toISOString() })
      .eq('status', 'pending')
      .lt('createdAt', staleCutoff)

    await sendMarkdownSafe(
      bot.telegram,
      ownerChatId,
      `⏰ ${staleRows.length}টি approval ৪৮ ঘণ্টা ধরে pending ছিল — auto-expire করা হলো। দরকার হলে আবার বলুন।`,
    ).catch((err) => {
      console.warn('[approval-tracker] expire notification to owner failed:', err.message)
    })
  }

  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString()
  const { data: pendingRaw } = await supabase
    .from('agent_pending_actions')
    .select('id, type, summary, createdAt')
    .eq('status', 'pending')
    .lt('createdAt', cutoff)
    .order('createdAt', { ascending: true })

  if (!pendingRaw?.length) return

  // Transient cards past their 30-min TTL are dead — the Approval Center and
  // get_pending_approvals already hide them. Sweep them to 'expired' and never
  // nag about them, so the owner never sees "N pending" for cards the app shows
  // as empty. Lifecycle cards (dispatch_staff_tasks) survive and still remind.
  const expired = pendingRaw.filter((p) => isPendingActionExpired(p.createdAt, p.type))
  if (expired.length) {
    // supabase-js query builders are thenable but have no `.catch` — calling
    // `.in(...).catch(fn)` throws "catch is not a function". Await and check the
    // returned error instead.
    const { error: sweepErr } = await supabase
      .from('agent_pending_actions')
      .update({ status: 'expired', resolvedAt: new Date().toISOString() })
      .in('id', expired.map((p) => p.id))
    if (sweepErr) console.warn('[approval-tracker] transient expire sweep failed:', sweepErr.message)
  }
  const pending = pendingRaw.filter((p) => !isPendingActionExpired(p.createdAt, p.type))
  if (!pending.length) return

  const sorted = [...pending].sort((a, b) => priorityRank(a.type) - priorityRank(b.type))

  const lines = [`📌 *এখনো ${sorted.length}টি approval বাকি:*`, '']
  sorted.slice(0, 10).forEach((p, i) => {
    const created = p.createdAt ?? p.created_at
    const ageMin = Math.round((Date.now() - new Date(created).getTime()) / 60000)
    const ageLabel = ageMin >= 60 ? `${Math.round(ageMin / 60)} ঘণ্টা` : `${ageMin} মিনিট`
    const summary = (p.summary ?? '').replace(/\n/g, ' ').slice(0, 120)
    lines.push(`${i + 1}. ${summary} _(${ageLabel} আগে)_`)
  })
  if (sorted.length > 10) lines.push(`…আরও ${sorted.length - 10}টি`)
  lines.push('')
  lines.push('প্রতিটি দেখতে/approve করতে নিচের বাটন বা সংশ্লিষ্ট মেসেজে যান।')

  await sendMarkdownSafe(bot.telegram, ownerChatId, lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [[
        { text: '📋 সব দেখুন', callback_data: buildCallbackData('approvals_show_all', 'x') },
        { text: '🔕 আজ চুপ', callback_data: buildCallbackData('approvals_mute_today', 'x') },
      ]],
    },
  })

  console.log(`[approval-tracker] reminded owner about ${sorted.length} pending approvals`)
}
