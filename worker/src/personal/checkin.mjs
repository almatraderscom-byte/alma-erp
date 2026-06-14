import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { isPersonalSnoozedToday } from './snooze.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

const FALLBACK = {
  midday:
    'স্যার, দিনটা কেমন যাচ্ছে? সব ঠিক আছে তো? কিছু দরকার হলে বা মন খারাপ থাকলে বলবেন — আমি আছি। 🤲',
  evening:
    'আসসালামু আলাইকুম স্যার। দিনটা কেমন গেল? পরিবারের সবার সাথে কথা হয়েছে আজ? কোনো কিছু মন খারাপ করছে কি না — বলতে পারেন, আমি আছি।',
}

async function sendPersonalCheckin({ bot, supabase, kind }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) return

  if (supabase && (await isPersonalSnoozedToday(supabase))) {
    console.log(`[personal-checkin] skipped ${kind} — snoozed today`)
    return
  }

  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/personal-checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT()}` },
      body: JSON.stringify({ kind }),
    })
    const data = await res.json().catch(() => ({}))
    const text = data.message || FALLBACK[kind] || FALLBACK.evening
    await sendMarkdownSafe(bot.telegram, ownerChatId, text)
    console.log(`[personal-checkin] sent ${kind} check-in`)
  } catch (e) {
    console.error(`[personal-checkin] ${kind} failed:`, e.message)
  }
}

/** Gentle evening personal check-in (21:00 Dhaka). */
export async function runPersonalCheckin({ bot, supabase }) {
  await sendPersonalCheckin({ bot, supabase, kind: 'evening' })
}

/** Brief midday personal touch (14:00 Dhaka). */
export async function runPersonalMidday({ bot, supabase }) {
  await sendPersonalCheckin({ bot, supabase, kind: 'midday' })
}
