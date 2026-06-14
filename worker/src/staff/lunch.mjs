/**
 * Staff lunch tracking — 45 min allowance, start/end via Telegram.
 */

import { replyMarkdownSafe } from '../telegram/markdown-safe.mjs'

export function dhakaLunchDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/** Inline keyboard row: lunch start + return buttons */
export function lunchButtonRow() {
  return [
    { text: '🍽️ লাঞ্চে যাচ্ছি', callback_data: 'lunch_start' },
    { text: '✅ ফিরেছি', callback_data: 'lunch_end' },
  ]
}

export function isLunchStartText(text) {
  const t = text.trim()
  return t === 'লাঞ্চে যাচ্ছি' || t.toLowerCase() === 'lunch'
}

export function isLunchEndText(text) {
  return text.trim() === 'ফিরেছি'
}

export async function handleLunchStart(ctx, supabase, staff) {
  const lunchDate = dhakaLunchDate()

  const { data: open } = await supabase
    .from('staff_lunch')
    .select('id')
    .eq('staff_id', staff.id)
    .eq('lunch_date', lunchDate)
    .is('ended_at', null)
    .maybeSingle()

  if (!open) {
    await supabase.from('staff_lunch').insert({
      staff_id: staff.id,
      staff_name: staff.name,
      lunch_date: lunchDate,
      started_at: new Date().toISOString(),
    })
  }

  await replyMarkdownSafe(
    ctx,
    `🍽️ ঠিক আছে ${staff.name} ভাই, লাঞ্চ শুরু — ৪৫ মিনিট। ফিরে এসে "ফিরেছি" লিখুন বা বাটনে চাপুন। নিয়ত করে খাবেন! 🤲`,
  )
}

export async function handleLunchEnd(ctx, supabase, staff) {
  const lunchDate = dhakaLunchDate()

  const { data: lunch } = await supabase
    .from('staff_lunch')
    .select('id, started_at')
    .eq('staff_id', staff.id)
    .eq('lunch_date', lunchDate)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .maybeSingle()

  if (!lunch) {
    await replyMarkdownSafe(ctx, `ℹ️ ${staff.name} ভাই, আজকের কোনো খোলা লাঞ্চ রেকর্ড নেই। লাঞ্চে যাওয়ার আগে "লাঞ্চে যাচ্ছি" চাপুন।`)
    return
  }

  const durationMin = Math.round((Date.now() - new Date(lunch.started_at).getTime()) / 60000)
  await supabase
    .from('staff_lunch')
    .update({
      ended_at: new Date().toISOString(),
      duration_min: durationMin,
      overage: durationMin > 45,
    })
    .eq('id', lunch.id)

  const msg =
    durationMin <= 45
      ? `✅ স্বাগতম ${staff.name} ভাই! ${durationMin} মিনিটে ফিরেছেন — চমৎকার। এবার কাজে মন দিন। 💪`
      : `✅ ফিরেছেন ${staff.name} ভাই (${durationMin} মিনিট)। একটু বেশি হয়ে গেল — পরের বার ৪৫ মিনিটে রাখার চেষ্টা করুন। 🙂`

  await replyMarkdownSafe(ctx, msg)
}
