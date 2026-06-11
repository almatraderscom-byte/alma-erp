/**
 * Phase 10 — Staff GPS via Telegram live location + task-done prompts.
 */
import { notify } from '../notify/index.mjs'

const throttleMap = new Map() // staffId → lastInsertMs
const THROTTLE_MS = 2 * 60 * 1000

const pendingLocationRequest = new Map() // chatId → { staffId, staffName, taskId? }

export function markPendingLocationRequest(chatId, staffId, staffName, taskId = null) {
  pendingLocationRequest.set(String(chatId), { staffId, staffName, taskId, at: Date.now() })
}

export async function resolveStaffByChatId(supabase, chatId) {
  const { data } = await supabase
    .from('agent_staff')
    .select('id, name')
    .eq('telegram_chat_id', String(chatId))
    .eq('active', true)
    .limit(1)
  return data?.[0] ?? null
}

async function insertLocation(supabase, { staffId, lat, lng, accuracy, source, metadata }) {
  const now = Date.now()
  const last = throttleMap.get(staffId) ?? 0
  if (now - last < THROTTLE_MS && source === 'live') return false
  throttleMap.set(staffId, now)

  await supabase.from('staff_locations').insert({
    id:          crypto.randomUUID(),
    staff_id:    staffId,
    lat,
    lng,
    accuracy:    accuracy ?? null,
    recorded_at: new Date().toISOString(),
    source,
    metadata:    metadata ?? null,
    created_at:  new Date().toISOString(),
  })
  return true
}

function formatDhakaTime() {
  return new Date().toLocaleString('en-BD', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * Handle location message from linked staff.
 */
export async function handleStaffLocation(ctx, supabase, location, source = 'live') {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const staff = await resolveStaffByChatId(supabase, chatId)
  if (!staff) return

  const { latitude: lat, longitude: lng, horizontal_accuracy: accuracy, live_period: livePeriod } = location

  const inserted = await insertLocation(supabase, {
    staffId: staff.id,
    lat,
    lng,
    accuracy,
    source: pendingLocationRequest.has(String(chatId)) ? 'task_done' : source,
    metadata: livePeriod != null ? `live_period=${livePeriod}` : null,
  })

  pendingLocationRequest.delete(String(chatId))

  if (inserted && source === 'task_done') {
    await ctx.reply('✅ লোকেশন সংরক্ষিত হয়েছে। জাযাকাল্লাহ খাইর!')
  }
}

/**
 * Live location stopped — live_period becomes 0 or message has no live_period on final update.
 */
export async function handleLiveLocationStopped(ctx, supabase, staffName) {
  const staff = await resolveStaffByChatId(supabase, ctx.chat?.id)
  if (!staff) return

  await insertLocation(supabase, {
    staffId: staff.id,
    lat: 0,
    lng: 0,
    source: 'live',
    metadata: 'stopped',
  })

  const time = formatDhakaTime()
  await notify({
    tier: 1,
    title: 'লোকেশন শেয়ার বন্ধ',
    message: `${staffName ?? staff.name} location share বন্ধ করেছে ${time}`,
    category: 'staff',
  })
}

/**
 * After task Done — ask staff once for location (skippable).
 */
export async function promptTaskDoneLocation(ctx, staffId, staffName) {
  markPendingLocationRequest(ctx.chat?.id, staffId, staffName)
  await ctx.reply(
    '✅ কাজ সম্পন্ন! অফিস সময়ে ফিল্ড ট্র্যাকিংয়ের জন্য একবার বর্তমান লোকেশন শেয়ার করুন (ঐচ্ছিক)।',
    {
      reply_markup: {
        keyboard: [
          [{ text: '📍 লোকেশন শেয়ার করুন', request_location: true }],
          [{ text: 'লোকেশন skip' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    },
  )
}

export const STAFF_ONBOARDING_BANGLA = `আস্সালামু আলাইকুম!

ALMA অফিসে কাজের সময় আপনার Telegram থেকে *Live Location* শেয়ার করুন — এটি শুধুমাত্র আপনি যা actively শেয়ার করবেন তাই ট্র্যাক হবে। কোনো গোপন ট্র্যাকিং নেই।

কীভাবে:
1. Telegram → Attachment → Location → *Share Live Location*
2. অফিস সময় শেষে Share বন্ধ করুন

কাজ Done করার পর bot একবার লোকেশন চাইতে পারে — দিতে না পারলে skip করতে পারবেন।

জাযাকাল্লাহ খাইর।`
