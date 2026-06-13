/**
 * Phase 10 — Staff GPS via Telegram live location (voluntary sharing only).
 * Live location and one-shot shares are tracked when staff actively sends them.
 */
import { notify } from '../notify/index.mjs'

const throttleMap = new Map() // staffId → lastInsertMs
const THROTTLE_MS = 2 * 60 * 1000

/** Onboard GPS guide — staff must share location within this window after onboarding message. */
export const LOCATION_TIMEOUT_MS = 3 * 60 * 1000

const pendingLocationRequest = new Map() // chatId → { staffId, staffName, at, reason: 'onboard' }
const locationTimeouts = new Map() // chatId → timeoutId
const liveOwnerNotified = new Set() // chatId — owner notified once per live session

function clearLocationTimeout(chatId) {
  const key = String(chatId)
  const tid = locationTimeouts.get(key)
  if (tid) {
    clearTimeout(tid)
    locationTimeouts.delete(key)
  }
}

export function markPendingLocationRequest(chatId, staffId, staffName, _taskId = null, reason = 'onboard') {
  const key = String(chatId)
  clearLocationTimeout(key)
  pendingLocationRequest.set(key, { staffId, staffName, at: Date.now(), reason })
}

export function scheduleLocationTimeout(chatId, staffName) {
  const key = String(chatId)
  clearLocationTimeout(key)
  const timeoutId = setTimeout(async () => {
    if (!pendingLocationRequest.has(key)) return
    const pending = pendingLocationRequest.get(key)
    pendingLocationRequest.delete(key)
    locationTimeouts.delete(key)
    const name = pending?.staffName ?? staffName ?? 'স্টাফ'
    await notify({
      tier: 1,
      title: '⚠️ লোকেশন পাঠায়নি',
      message: `${name} GPS অনবোর্ডিং গাইড পাওয়ার পর ৩ মিনিটে লোকেশন পাঠায়নি।`,
      category: 'staff',
      ntfyMode: 'critical',
    }).catch((err) => console.warn('[location] timeout notify failed:', err.message))
  }, LOCATION_TIMEOUT_MS)
  locationTimeouts.set(key, timeoutId)
}

export async function resolveStaffByChatId(supabase, chatId) {
  const { data } = await supabase
    .from('agent_staff')
    .select('id, name')
    .eq('telegramChatId', String(chatId))
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
    metadata:    metadata ?? 'active',
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

  const pendingKey = String(chatId)
  const pendingInfo = pendingLocationRequest.get(pendingKey)
  const wasPending = pendingLocationRequest.has(pendingKey)
  const inserted = await insertLocation(supabase, {
    staffId: staff.id,
    lat,
    lng,
    accuracy,
    source,
    metadata: livePeriod != null ? `live_period=${livePeriod}` : 'active',
  })

  pendingLocationRequest.delete(pendingKey)
  clearLocationTimeout(chatId)

  const isLiveShare = source === 'live' || livePeriod != null
  const shouldNotifyOwner =
    wasPending
    || (!isLiveShare)
    || !liveOwnerNotified.has(pendingKey)

  if (inserted && lat !== 0 && lng !== 0 && shouldNotifyOwner) {
    if (isLiveShare) liveOwnerNotified.add(pendingKey)
    const time = formatDhakaTime()
    const maps = `https://www.google.com/maps?q=${lat},${lng}`
    let context = 'লোকেশন শেয়ার করেছে'
    if (pendingInfo?.reason === 'onboard') {
      context = 'GPS অনবোর্ডিংয়ের পর লোকেশন শেয়ার করেছে'
    }
    await notify({
      tier: 1,
      title: `📍 ${staff.name} লোকেশন`,
      message: `${staff.name} ${context} (${time})\n${maps}`,
      category: 'staff',
    }).catch((err) => console.warn('[location] owner notify failed:', err.message))
  }

  if (inserted && wasPending) {
    await ctx.reply('✅ লোকেশন সংরক্ষিত হয়েছে। জাযাকাল্লাহ খাইর!')
  }
}

/**
 * Live location stopped — live_period becomes 0 or message has no live_period on final update.
 */
export async function handleLiveLocationStopped(ctx, supabase, staffName) {
  const chatId = ctx.chat?.id
  if (chatId) liveOwnerNotified.delete(String(chatId))

  const staff = await resolveStaffByChatId(supabase, chatId)
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

export const STAFF_ONBOARDING_BANGLA = `আস্সালামু আলাইকুম!

ALMA অফিসে কাজের সময় আপনার Telegram থেকে *Live Location* শেয়ার করুন — এটি শুধুমাত্র আপনি যা actively শেয়ার করবেন তাই ট্র্যাক হবে। কোনো গোপন ট্র্যাকিং নেই।

কীভাবে:
1. Telegram → Attachment → Location → *Share Live Location*
2. অফিস সময় শেষে Share বন্ধ করুন

জাযাকাল্লাহ খাইর।`

/** Send GPS onboarding guide to all linked active staff. */
export async function broadcastStaffOnboard(telegram, supabase) {
  const { data: staff, error } = await supabase
    .from('agent_staff')
    .select('id, name, telegramChatId')
    .eq('active', true)
    .not('telegramChatId', 'is', null)

  if (error) throw new Error(error.message)

  let sent = 0
  const failed = []
  const onboarded = []
  for (const s of staff ?? []) {
    if (!s.telegramChatId) continue
    try {
      await telegram.sendMessage(s.telegramChatId, STAFF_ONBOARDING_BANGLA, { parse_mode: 'Markdown' })
      markPendingLocationRequest(s.telegramChatId, s.id, s.name, null, 'onboard')
      scheduleLocationTimeout(s.telegramChatId, s.name)
      sent++
      onboarded.push(s.name)
    } catch (err) {
      console.warn(`[location] onboard failed for ${s.name}:`, err.message)
      failed.push(s.name)
    }
  }
  return { sent, failed, total: (staff ?? []).length, onboarded }
}
