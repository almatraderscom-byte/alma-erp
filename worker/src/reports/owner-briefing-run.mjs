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
  } catch (e) {
    console.error('[owner-briefing] failed:', e.message)
  }
}
