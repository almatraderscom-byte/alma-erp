import { buildOwnerBriefing, renderBriefing } from './owner-briefing.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

export async function runOwnerBriefing({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) {
    console.warn('[owner-briefing] TELEGRAM_OWNER_CHAT_ID not set — skipped')
    return
  }

  try {
    const brief = await buildOwnerBriefing({ supabase })
    const text = renderBriefing(brief)
    await sendMarkdownSafe(bot.telegram, ownerChatId, text)

    try {
      const { sendVoiceMessage } = await import('../telegram/voice.mjs')
      const voiceText = text.replace(/[*_🎯🔴🟡✅💰💬📦👥☀️📣]/g, '')
      await sendVoiceMessage(bot, ownerChatId, voiceText)
    } catch (voiceErr) {
      console.warn('[owner-briefing] voice note skipped:', voiceErr.message)
    }

    const charCount = text.length
    return { dutyStatus: 'done', dutyDetail: `ব্রিফিং পাঠানো হয়েছে (${charCount} chars)` }
  } catch (e) {
    console.error('[owner-briefing] failed:', e.message)
    return { dutyStatus: 'error', dutyDetail: `ব্রিফিং ব্যর্থ: ${e.message.slice(0, 50)}` }
  }
}
