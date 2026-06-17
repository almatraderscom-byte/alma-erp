/**
 * Overdue lunch checker — every 5 min.
 * >45 min: NTFY + Telegram to staff, 🟡 notice to owner.
 * ≥60 min: 🔴 critical to owner + ntfy critical.
 */

import { sendNtfyToTopic, sendNtfy } from '../notify/ntfy.mjs'
import { staffNtfyTopic, staffTelegramChatId } from './staff-fields.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { dhakaLunchDate } from './lunch.mjs'
import { isStaffOnLeaveSb } from './leave.mjs'

export async function runLunchWatch({ supabase, bot }) {
  if (!bot) return

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  const now = Date.now()
  const lunchDate = dhakaLunchDate()

  const { data: open } = await supabase
    .from('staff_lunch')
    .select('id, staff_id, staff_name, started_at, warned_45, alerted_60')
    .eq('lunch_date', lunchDate)
    .is('ended_at', null)

  if (!open?.length) return

  for (const l of open) {
    if (await isStaffOnLeaveSb(supabase, l.staff_id, lunchDate)) continue

    const mins = Math.round((now - new Date(l.started_at).getTime()) / 60000)

    if (mins > 45 && !l.warned_45) {
      const { data: staff } = await supabase
        .from('agent_staff')
        .select('telegramChatId, ntfy_topic, name')
        .eq('id', l.staff_id)
        .maybeSingle()

      const topic = staffNtfyTopic(staff)
      if (topic) {
        await sendNtfyToTopic(
          topic,
          'লাঞ্চ শেষ',
          `${staff?.name ?? 'স্টাফ'}, ৪৫ মিনিট হয়ে গেছে — ফিরে আসুন।`,
          'urgent',
        ).catch((err) => {
          console.warn('[lunch-watch] ntfy send failed:', err.message)
        })
      }
      const chatId = staffTelegramChatId(staff)
      if (chatId) {
        await sendMarkdownSafe(
          bot.telegram,
          chatId,
          `⏰ ${staff.name} ভাই, ৪৫ মিনিট হয়ে গেছে — কাজে ফিরে "ফিরেছি" লিখুন। 🙂`,
        ).catch((err) => {
          console.warn(`[lunch-watch] staff send failed for ${staff.name}:`, err.message)
        })
      }
      if (ownerChatId) {
        await sendMarkdownSafe(
          bot.telegram,
          ownerChatId,
          `🟡 ${l.staff_name} লাঞ্চে ৪৫ মিনিট পার করেছে — এখনো ফেরেনি।`,
        ).catch((err) => {
          console.warn('[lunch-watch] owner 45-min alert failed:', err.message)
        })
      }
      await supabase.from('staff_lunch').update({ warned_45: true, overage: true }).eq('id', l.id)
    }

    if (mins >= 60 && !l.alerted_60) {
      if (ownerChatId) {
        await sendMarkdownSafe(
          bot.telegram,
          ownerChatId,
          `🔴 ${l.staff_name} লাঞ্চে ${mins} মিনিট — ৬০+ মিনিট পার! এখনো ফেরেনি। action নিন।`,
        ).catch((err) => {
          console.warn('[lunch-watch] owner 60-min alert failed:', err.message)
        })
      }
      await sendNtfy(
        'critical',
        'Staff lunch overrun',
        `${l.staff_name} lunch ${mins} min — fereni`,
        'urgent',
      ).catch((err) => {
        console.warn('[lunch-watch] ntfy critical failed:', err.message)
      })
      await supabase.from('staff_lunch').update({ alerted_60: true }).eq('id', l.id)
    }
  }
}
