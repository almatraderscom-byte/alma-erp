/**
 * Real-time geo-monitoring — runs every 2 min during office hours.
 * Checks each active staff's latest Telegram live location against the office geo-fence.
 * Alerts:
 *  - Staff left office zone (instant owner Telegram + ntfy)
 *  - Staff location stopped updating (live location expired or turned off)
 *  - Ghost check-in (checked in but left within 30 min)
 */
import { isWithinOfficeHours } from './office-hours.mjs'
import { notify } from '../notify/index.mjs'
import { bnNum } from './bn-format.mjs'

const OFFICE_LAT = Number(process.env.OFFICE_ALMA_LIFESTYLE_LAT || process.env.OFFICE_LAT || 0)
const OFFICE_LNG = Number(process.env.OFFICE_ALMA_LIFESTYLE_LNG || process.env.OFFICE_LNG || 0)
const OFFICE_RADIUS_M = Number(process.env.OFFICE_ALMA_LIFESTYLE_RADIUS_M || process.env.OFFICE_RADIUS_M || 300)
const OWNER_CHAT_ID = process.env.OWNER_TELEGRAM_CHAT_ID

const STALE_LOCATION_MINUTES = 10
const GRACE_PERIOD_MS = 5 * 60 * 1000
const ALERT_COOLDOWN_MS = 30 * 60 * 1000
const GHOST_CHECKIN_WINDOW_MS = 30 * 60 * 1000

const alertCooldowns = new Map()

function haversineDistanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function isInCooldown(staffId, alertType) {
  const key = `${staffId}:${alertType}`
  const last = alertCooldowns.get(key) ?? 0
  return Date.now() - last < ALERT_COOLDOWN_MS
}

function markAlerted(staffId, alertType) {
  alertCooldowns.set(`${staffId}:${alertType}`, Date.now())
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)}m`
  return `${(meters / 1000).toFixed(1)}km`
}

export async function runGeoMonitor(context) {
  const { supabase, bot } = context

  if (!isWithinOfficeHours()) {
    return { dutyStatus: 'skipped', dutyDetail: 'outside office hours' }
  }

  if (!OFFICE_LAT || !OFFICE_LNG) {
    return { dutyStatus: 'skipped', dutyDetail: 'office coordinates not configured' }
  }

  const { data: staffList } = await supabase
    .from('agent_staff')
    .select('id, name, telegramChatId')
    .eq('active', true)
    .eq('business_id', 'ALMA_LIFESTYLE')

  if (!staffList?.length) return { dutyStatus: 'done', dutyDetail: 'no active staff' }

  const now = new Date()
  const alerts = []

  for (const staff of staffList) {
    const { data: locations } = await supabase
      .from('staff_locations')
      .select('lat, lng, recorded_at, source')
      .eq('staff_id', staff.id)
      .order('recorded_at', { ascending: false })
      .limit(1)

    const latest = locations?.[0]

    if (!latest) {
      if (!isInCooldown(staff.id, 'no_location')) {
        alerts.push({
          staffId: staff.id,
          staffName: staff.name,
          type: 'no_location',
          message: `📍 ${staff.name} — কোনো লোকেশন ডেটা নেই। Live Location চালু নেই।`,
        })
        markAlerted(staff.id, 'no_location')
      }
      continue
    }

    const recordedAt = new Date(latest.recorded_at)
    const ageMinutes = (now.getTime() - recordedAt.getTime()) / 60_000

    if (ageMinutes > STALE_LOCATION_MINUTES) {
      if (!isInCooldown(staff.id, 'stale')) {
        alerts.push({
          staffId: staff.id,
          staffName: staff.name,
          type: 'stale',
          message: `📍 ${staff.name} — Live Location ${bnNum(Math.round(ageMinutes))} মিনিট ধরে আপডেট হয়নি। বন্ধ করে দিয়েছে অথবা নেটওয়ার্ক সমস্যা।`,
        })
        markAlerted(staff.id, 'stale')
      }
      continue
    }

    const distance = haversineDistanceM(OFFICE_LAT, OFFICE_LNG, latest.lat, latest.lng)

    if (distance > OFFICE_RADIUS_M) {
      if (!isInCooldown(staff.id, 'outside')) {
        const dist = formatDistance(distance)
        alerts.push({
          staffId: staff.id,
          staffName: staff.name,
          type: 'outside',
          distance,
          message: `🚨 ${staff.name} অফিস zone-এর বাইরে! (${dist} দূরে)\nhttps://www.google.com/maps?q=${latest.lat},${latest.lng}`,
        })
        markAlerted(staff.id, 'outside')
      }
    }
  }

  if (alerts.length > 0 && bot && OWNER_CHAT_ID) {
    for (const alert of alerts) {
      try {
        await bot.telegram.sendMessage(OWNER_CHAT_ID, alert.message, { parse_mode: 'HTML' })
      } catch (err) {
        console.warn(`[geo-monitor] telegram alert failed for ${alert.staffName}:`, err.message)
      }

      if (alert.type === 'outside') {
        await notify({
          tier: 1,
          title: `🚨 ${alert.staffName} অফিসের বাইরে`,
          message: alert.message,
          category: 'staff',
          ntfyMode: 'critical',
        }).catch(() => {})
      }
    }
  }

  const detail = alerts.length > 0
    ? `${alerts.length} alert(s): ${alerts.map((a) => `${a.staffName}:${a.type}`).join(', ')}`
    : `${staffList.length} staff checked — all within zone`
  return { dutyStatus: 'done', dutyDetail: detail }
}

/**
 * Ghost check-in detection — called from ERP attendance check-in webhook or cron.
 * If staff checked in but their location shows they left within 30 min, flag it.
 */
export async function checkGhostCheckins(context) {
  const { supabase, bot } = context
  if (!OFFICE_LAT || !OFFICE_LNG) return

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  const { data: records } = await supabase
    .from('agent_kv_settings')
    .select('key, value')
    .like('key', `ghost_checkin_checked:${today}:%`)

  const alreadyChecked = new Set((records ?? []).map((r) => r.key.split(':')[2]))

  const { data: staffList } = await supabase
    .from('agent_staff')
    .select('id, name, user_id')
    .eq('active', true)
    .eq('business_id', 'ALMA_LIFESTYLE')

  if (!staffList?.length) return

  for (const staff of staffList) {
    if (alreadyChecked.has(staff.id)) continue
    if (!staff.user_id) continue

    const { data: attendance } = await supabase
      .from('attendance_records')
      .select('check_in_at, latitude, longitude')
      .eq('employee_id', staff.user_id)
      .eq('attendance_date', today)
      .eq('business_id', 'ALMA_LIFESTYLE')
      .maybeSingle()

    if (!attendance?.check_in_at) continue

    const checkInTime = new Date(attendance.check_in_at)
    const elapsed = Date.now() - checkInTime.getTime()

    if (elapsed < GHOST_CHECKIN_WINDOW_MS) continue

    const { data: locations } = await supabase
      .from('staff_locations')
      .select('lat, lng, recorded_at')
      .eq('staff_id', staff.id)
      .gte('recorded_at', checkInTime.toISOString())
      .order('recorded_at', { ascending: true })
      .limit(20)

    if (!locations?.length) continue

    const leftWithin30 = locations.find((loc) => {
      const locTime = new Date(loc.recorded_at)
      const sincCheckin = locTime.getTime() - checkInTime.getTime()
      if (sincCheckin > GHOST_CHECKIN_WINDOW_MS) return false
      const dist = haversineDistanceM(OFFICE_LAT, OFFICE_LNG, loc.lat, loc.lng)
      return dist > OFFICE_RADIUS_M
    })

    if (leftWithin30) {
      const dist = formatDistance(haversineDistanceM(OFFICE_LAT, OFFICE_LNG, leftWithin30.lat, leftWithin30.lng))
      const msg = `👻 *Ghost Check-in সন্দেহ*\n${staff.name} — চেক-ইন করার ${bnNum(Math.round((new Date(leftWithin30.recorded_at).getTime() - checkInTime.getTime()) / 60_000))} মিনিটের মধ্যে অফিস ছেড়েছে (${dist} দূরে)।`

      if (bot && OWNER_CHAT_ID) {
        await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {})
      }
    }

    await supabase.from('agent_kv_settings').upsert({
      key: `ghost_checkin_checked:${today}:${staff.id}`,
      value: JSON.stringify({ checked: true, at: new Date().toISOString() }),
      updated_at: new Date().toISOString(),
    })
  }
}
