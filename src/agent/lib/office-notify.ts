/**
 * Office push fan-out — Telegram becomes "notify-only" on top of the in-app
 * office. Every in-app notification can fire a short Telegram (and ntfy) ping
 * so nobody has to keep the app open. All best-effort: a push failure must
 * never break the DB action that triggered it.
 */
import { sendTelegramMessage } from '@/lib/trading-telegram-bot'
import { sendStaffNtfy } from '@/agent/lib/notify-owner'

const APP_BASE = (process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const OFFICE_URL = `${APP_BASE}/portal/office`

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
