/**
 * Unified notification dispatcher.
 *
 * Tier 1: Telegram text (+ voice note if voice:true) + ntfy GENERAL
 * Tier 2: Tier 1 + ntfy CRITICAL (priority 5)
 * Tier 3: Tier 2 + Twilio phone call
 *
 * Every call is logged to the agent_notifications table via the app API.
 * A notification is not counted as "sent" unless the channel confirmed it.
 */

import { sendNtfy } from './ntfy.mjs'
import { makeTwilioCall } from './twilio-call.mjs'
// Telegram bot instance is set after the Telegram module boots.
let _telegramBot = null
let _ownerChatId = null

export function setTelegramForNotify(bot, ownerChatId) {
  _telegramBot = bot
  _ownerChatId = String(ownerChatId)
}

// App URL for logging
const APP_URL    = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN  = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/**
 * Native app push (OneSignal → APNs/FCM) to the owner's installed app.
 *
 * OneSignal credentials live in Vercel, so instead of duplicating them here the
 * worker asks the app to send via an owner-only internal endpoint. Fail-open:
 * any error is swallowed so Telegram / ntfy / Twilio are never blocked.
 */
async function sendNativePush(tier, title, message, category) {
  try {
    const url = APP_URL()
    const token = INT_TOKEN()
    if (!url || !token) return { ok: false, reason: 'unconfigured' }
    const res = await fetch(`${url}/api/assistant/internal/native-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tier, title, message, category }),
    })
    if (!res.ok) return { ok: false, reason: `http_${res.status}` }
    const data = await res.json().catch(() => ({}))
    return { ok: Boolean(data?.ok), reason: data?.reason }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

async function logNotification(tier, category, channels, statuses, title, message) {
  try {
    await fetch(`${APP_URL()}/api/assistant/internal/notification-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INT_TOKEN()}`,
      },
      body: JSON.stringify({
        tier,
        category,
        channels,
        statuses,
        title: String(title),
        message: String(message),
      }),
    })
  } catch {
    // Non-fatal — logging failure doesn't block delivery
  }
}

/**
 * @param {{
 *   tier: 1|2|3,
 *   title: string,
 *   message: string,
 *   category?: 'salah'|'urgent'|'task'|'report',
 *   voice?: boolean,
 *   skipTelegram?: boolean,
 *   salahDate?: string,
 *   salahWaqt?: string,
 * }} opts
 */
/**
 * @param {'both'|'general'|'critical'|'none'} ntfyMode
 *   salah: use 'critical' only — avoids duplicate push with same body as Telegram.
 */
export async function notify({
  tier,
  title,
  message,
  category,
  voice = false,
  skipTelegram = false,
  ntfyMode = 'both',
  voiceMessage,
  salahDate,
  salahWaqt,
}) {
  const channels = []
  const statuses = {}

  // ── Tier 1: Telegram text ─────────────────────────────────────────────────
  if (!skipTelegram && _telegramBot && _ownerChatId) {
    channels.push('telegram')
    try {
      const fullText = `*${title}*\n\n${message}`
      await _telegramBot.telegram.sendMessage(_ownerChatId, fullText, { parse_mode: 'Markdown' })
      statuses.telegram = 'sent'
    } catch (err) {
      statuses.telegram = `error: ${err.message}`
    }
  } else if (!skipTelegram) {
    statuses.telegram = 'skipped: bot not initialized'
  }

  // Voice note — independent of skipTelegram (salah sends its own Telegram text + buttons).
  if (voice && _telegramBot && _ownerChatId) {
    channels.push('telegram_voice')
    try {
      const { sendVoiceMessage } = await import('../telegram/voice.mjs')
      const speech = voiceMessage ?? `${title}. ${message}`
      await sendVoiceMessage(_telegramBot, _ownerChatId, speech, {
        isSalah: category === 'salah',
        useOwnerVoice: category !== 'salah',
        useElevenLabs: false,
        voiceProfile: 'male',
      })
      statuses.telegram_voice = 'sent'
    } catch (err) {
      statuses.telegram_voice = `error: ${err.message}`
    }
  }

  // ── Native app push (OneSignal → APNs) — owner's iOS/Android app notifies like a
  //    real app. First-class channel; fail-open so it never blocks the others. ──
  channels.push('native_push')
  const nativeResult = await sendNativePush(tier, title, message, category)
  statuses.native_push = nativeResult.ok ? 'sent' : `error: ${nativeResult.reason}`

  const sendGeneral = ntfyMode === 'both' || ntfyMode === 'general'
  const sendCritical = ntfyMode === 'both' || ntfyMode === 'critical'

  if (sendGeneral) {
    channels.push('ntfy_general')
    const ntfyGenResult = await sendNtfy('general', title, message, category)
    statuses.ntfy_general = ntfyGenResult.ok ? 'sent' : `error: ${ntfyGenResult.error}`
  }

  if (tier >= 2 && sendCritical) {
    channels.push('ntfy_critical')
    const ntfyCritResult = await sendNtfy('critical', title, message, category)
    statuses.ntfy_critical = ntfyCritResult.ok ? 'sent' : `error: ${ntfyCritResult.error}`
  }

  // ── Tier 3: Twilio call ──────────────────────────────────────────────────
  if (tier >= 3) {
    channels.push('twilio_call')
    const callText = voiceMessage ?? `${title}. ${message}`
    const callResult = await makeTwilioCall(callText, {
      force: true,
      salah: category === 'salah',
      purpose: category === 'salah' ? 'salah' : undefined,
      salahDate: category === 'salah' ? salahDate : undefined,
      salahWaqt: category === 'salah' ? salahWaqt : undefined,
    })
    statuses.twilio_call = callResult.ok ? `sent:${callResult.callSid}` : `error: ${callResult.error}`
  }

  await logNotification(tier, category ?? null, channels, statuses, title, message)

  return { channels, statuses }
}
