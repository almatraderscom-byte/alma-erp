import { notify } from '../notify/index.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { buildStaffProposalKeyboard } from '../telegram/dispatcher.mjs'

function tomorrowDhaka() {
  return new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/**
 * Chase an unapproved task proposal. Escalating tiers:
 *  - 1st run (~22:30): gentle Telegram reminder + re-show approve buttons
 *  - 2nd run (~23:30): ntfy critical
 *  - Morning fallback handles the call (morning-staff-reminder)
 */
export async function runApprovalEscalation({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) return { dutyStatus: 'skipped', dutyDetail: 'no owner chat or bot' }

  const tomorrow = tomorrowDhaka()

  const { count: proposedCount } = await supabase
    .from('staff_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('proposed_for', tomorrow)
    .eq('status', 'proposed')

  const { count: approvedCount } = await supabase
    .from('staff_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('proposed_for', tomorrow)
    .eq('status', 'approved')

  if (!proposedCount || approvedCount > 0) {
    return
  }

  const nudgeKey = `approval_nudge_${tomorrow}`
  const { data: setting } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', nudgeKey)
    .maybeSingle()

  const raw = setting?.value
  const nudges = typeof raw === 'number'
    ? raw
    : Number(raw?.count ?? raw ?? 0)

  const { data: paRows } = await supabase
    .from('agent_pending_actions')
    .select('id, summary')
    .eq('type', 'dispatch_staff_tasks')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)

  const pendingAction = paRows?.[0]

  if (nudges === 0) {
    const keyboard = pendingAction?.id
      ? buildStaffProposalKeyboard(pendingAction.id, tomorrow, {
          approveLabel: '✅ Approve',
          rejectLabel: '❌ বাতিল',
        })
      : {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `proposal_approve:${tomorrow}` },
            { text: '👁 দেখুন', callback_data: `proposal_show:${tomorrow}` },
          ]],
        }

    await sendMarkdownSafe(
      bot.telegram,
      ownerChatId,
      `⏰ *আগামীকালের টাস্ক proposal এখনো approve করা হয়নি* (${proposedCount}টি কাজ)।\n\n` +
        'Approve না করলে সকালে স্টাফরা কাজ পাবে না।',
      { reply_markup: keyboard },
    )
  } else {
    await notify({
      tier: 2,
      title: '⚠️ Task proposal approve হয়নি',
      message: `আগামীকালের ${proposedCount}টি কাজ এখনো approve হয়নি। সকালে স্টাফরা কাজ পাবে না — এখনই approve করুন।`,
      category: 'urgent',
    })
  }

  await supabase.from('agent_kv_settings').upsert({
    key: nudgeKey,
    value: { count: nudges + 1, lastNudgeAt: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  })
}
