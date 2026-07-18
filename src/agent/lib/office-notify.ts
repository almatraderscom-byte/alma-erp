/**
 * Office push fan-out — Telegram becomes "notify-only" on top of the in-app
 * office. Every in-app notification can fire a short Telegram (and ntfy) ping
 * so nobody has to keep the app open. All best-effort: a push failure must
 * never break the DB action that triggered it.
 */
import { sendTelegramMessage } from '@/lib/trading-telegram-bot'
import { sendStaffNtfy } from '@/agent/lib/notify-owner'
import { ANDROID_NOTIFICATION_CHANNEL_ID } from '@/lib/notification-sound'

const APP_BASE = (process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const OFFICE_URL = `${APP_BASE}/portal/office`

/**
 * Fire a native OneSignal push straight to a staff member's installed app
 * (web + iOS/Android APK register with `OneSignal.login(userId)`, so their ERP
 * user id is the OneSignal external_id). Self-contained REST call — mirrors
 * native-owner-push.ts so it lights up exactly the subscriptions the app made,
 * WITHOUT writing to the ERP notifications table or importing ERP send code.
 *
 * `data` rides along so the in-app OneSignal click/foreground listener can
 * surface an incoming-call ring (data.type='office_call'). Never throws.
 *
 * @param userIds  ERP user ids to target (empty → clean no-op)
 * @param highPriority  OneSignal priority 10 + PUBLIC lock-screen (calls/urgent)
 */
export async function pushStaffDevice(
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, unknown> = {},
  highPriority = false,
): Promise<DevicePushResult> {
  const ids = [...new Set(userIds.filter(Boolean))]
  try {
    if (ids.length === 0) return { ok: true, attempted: 0, status: null, reason: 'no_targets' }
    const appId = process.env.ONESIGNAL_APP_ID || process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID
    const apiKey = process.env.ONESIGNAL_REST_API_KEY
    if (!appId || !apiKey) return { ok: false, attempted: ids.length, status: null, reason: 'onesignal_unconfigured' }

    const usesV2Key = apiKey.startsWith('os_v2_')
    const actionUrl = typeof data.actionUrl === 'string' && data.actionUrl ? data.actionUrl : OFFICE_URL

    const payload: Record<string, unknown> = {
      app_id: appId,
      target_channel: 'push',
      headings: { en: title },
      contents: { en: body },
      web_url: actionUrl,
      priority: highPriority ? 10 : 5,
      // Android 8+: the alma_alerts_v2 channel carries the sound; keep calls on it.
      existing_android_channel_id: ANDROID_NOTIFICATION_CHANNEL_ID,
      android_visibility: 1, // PUBLIC — show on lock screen (a call must be visible)
      ios_badgeType: 'Increase',
      ios_badgeCount: 1,
      small_icon: 'ic_stat_onesignal_default',
      data: { source: 'office', actionUrl, ...data },
    }
    if (usesV2Key) payload.include_aliases = { external_id: ids }
    else payload.include_external_user_ids = ids

    const response = await fetch(
      usesV2Key ? 'https://api.onesignal.com/notifications?c=push' : 'https://onesignal.com/api/v1/notifications',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `${usesV2Key ? 'Key' : 'Basic'} ${apiKey}`,
        },
        body: JSON.stringify(payload),
      },
    )
    return {
      ok: response.ok,
      attempted: ids.length,
      status: response.status,
      reason: response.ok ? null : `http_${response.status}`,
    }
  } catch (err) {
    console.warn('[office-notify] staff device push failed:', (err as Error)?.message)
    return { ok: false, attempted: ids.length, status: null, reason: 'request_failed' }
  }
}

export type DevicePushResult = {
  ok: boolean
  attempted: number
  status: number | null
  reason: string | null
}

/** Ping a staff member on Telegram + their ntfy topic. Never throws. */
export async function pushStaffPing(
  staff: { telegramChatId?: string | null; ntfyTopic?: string | null },
  title: string,
  body?: string,
): Promise<void> {
  const text = body ? `${title}\n${body}` : title
  const full = `${text}\n\n👉 অফিসে দেখুন: ${OFFICE_URL}`
  try {
    if (staff.telegramChatId) await sendTelegramMessage(staff.telegramChatId, full)
  } catch (err) {
    console.warn('[office-notify] staff telegram ping failed:', (err as Error)?.message)
  }
  try {
    if (staff.ntfyTopic) await sendStaffNtfy(staff.ntfyTopic, title, body ?? '', 'task')
  } catch (err) {
    console.warn('[office-notify] staff ntfy ping failed:', (err as Error)?.message)
  }
}

/** Ping the owner on Telegram (office events that need owner attention). Never throws. */
export async function pushOwnerPing(title: string, body?: string): Promise<void> {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim()
  if (!chatId) return
  const text = body ? `${title}\n${body}` : title
  try {
    await sendTelegramMessage(chatId, `${text}\n\n👉 অফিস হাব: ${OFFICE_URL}`)
  } catch (err) {
    console.warn('[office-notify] owner telegram ping failed:', (err as Error)?.message)
  }
}
