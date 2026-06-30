/**
 * Office under-occupancy ("absence") watch.
 *
 * Continuous GPS was never fed (nothing writes staff_locations), so the geofence
 * alert is effectively dead; and the camera idle-watch only flags a PRESENT person
 * doing off-task things — an empty / under-staffed room raised nothing. This closes
 * that gap by piggy-backing on the SAME camera idle-watch frame (same 5-min cron,
 * same vision people_count → no extra capture, no extra cost): it tracks how long
 * the room has stayed UNDER the expected head-count and, once that is sustained past
 * a threshold (default 30 min — lunch/prayer windows are already excluded by the
 * caller), it asks the owner one Telegram question:
 *
 *   "১ জন স্টাফ নেই — আপনি কি কাউকে বাইরে পাঠিয়েছেন?"   [✅ হ্যাঁ] [❌ না]
 *
 * The whole follow-up button flow rides the existing approve:/reject: callback
 * contract (the VPS bot understands only those two verbs), so every later choice is
 * modelled as its own pending action, each button an `approve:` on one of them:
 *   • ✅ হ্যাঁ → owner DID send someone out → time-picker (১/২/৪ ঘণ্টা) → a snooze
 *     window during which "1 short" is treated as perfect. 0-present still alerts.
 *   • ❌ না → owner did NOT → staff-picker (active staff names) → the chosen staffer
 *     gets a Telegram nudge + the camera screenshot.
 *
 * All state lives in agent_kv_settings (additive, no migration), mirroring the
 * geo_fence_state pattern. Every public entrypoint is best-effort and never throws.
 */
import { prisma } from '@/lib/prisma'
import { sendOwnerPhoto, sendTelegramPhoto, sendTelegramText } from '@/agent/lib/telegram-owner-notify'
import { DHAKA_TZ } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const BUSINESS_ID = 'ALMA_LIFESTYLE'

// KV keys (all owner-tunable via agent_kv_settings, no redeploy).
const ENABLED_KEY = 'office_absence_enabled'
const EXPECTED_KEY = 'office_absence_expected_count'
const THRESHOLD_KEY = 'office_absence_threshold_min'
const STATE_KEY = 'office_absence_state'
const SNOOZE_KEY = 'office_absence_snooze'

const DEFAULT_EXPECTED = 2
const DEFAULT_THRESHOLD_MIN = 30
// Tolerate one missed/occluded frame before the absence episode timer resets (cron = 5 min).
const GRACE_MIN = 11

// ── KV helpers ──────────────────────────────────────────────────────────────────
async function kvGet(key: string): Promise<string | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value ?? null
  } catch {
    return null
  }
}

async function kvSet(key: string, value: string): Promise<void> {
  await db.agentKvSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function kvDelete(key: string): Promise<void> {
  await db.agentKvSetting.deleteMany({ where: { key } }).catch(() => {})
}

async function getEnabled(): Promise<boolean> {
  const v = (await kvGet(ENABLED_KEY))?.trim().toLowerCase()
  return v !== 'off' && v !== 'false' && v !== '0'
}

async function getExpectedCount(): Promise<number> {
  const n = parseInt((await kvGet(EXPECTED_KEY)) ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EXPECTED
}

async function getThresholdMin(): Promise<number> {
  const n = parseInt((await kvGet(THRESHOLD_KEY)) ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_MIN
}

// ── Episode state ─────────────────────────────────────────────────────────────
interface AbsenceState {
  underStartedAt?: string
  lastSeenUnderAt?: string
  notifiedAt?: string
}

async function readState(): Promise<AbsenceState> {
  const raw = await kvGet(STATE_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as AbsenceState
  } catch {
    return {}
  }
}

async function writeState(s: AbsenceState): Promise<void> {
  await kvSet(STATE_KEY, JSON.stringify(s))
}

async function clearState(): Promise<void> {
  await kvDelete(STATE_KEY)
}

// ── Snooze window ─────────────────────────────────────────────────────────────
interface SnoozeWindow {
  until: string
  authorizedAbsent: number
  setAt: string
}

/** Active snooze (now < until), or null. */
async function readSnooze(now: Date): Promise<SnoozeWindow | null> {
  const raw = await kvGet(SNOOZE_KEY)
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as SnoozeWindow
    if (Date.parse(s.until) > now.getTime()) return s
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Owner confirmed he sent staff out → authorize `authorizedAbsent` missing staff
 * for `hours` hours. Clears the episode so the just-fired alert won't repeat and a
 * later 0-present (everyone gone) can alert fresh.
 */
export async function applyAbsenceSnooze(hours: number, authorizedAbsent = 1): Promise<{ until: Date }> {
  const now = new Date()
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000)
  await kvSet(
    SNOOZE_KEY,
    JSON.stringify({ until: until.toISOString(), authorizedAbsent, setAt: now.toISOString() } satisfies SnoozeWindow),
  )
  await clearState()
  return { until }
}

// ── Lunch exclusion ───────────────────────────────────────────────────────────
function dhakaYmd(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DHAKA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now) // en-CA → YYYY-MM-DD
}

/** Staff currently ON an open lunch break today — they are legitimately away. */
async function getOpenLunchCount(now: Date): Promise<number> {
  try {
    return await db.staffLunch.count({
      where: { businessId: BUSINESS_ID, lunchDate: dhakaYmd(now), endedAt: null },
    })
  } catch {
    return 0
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯']
function toBnNum(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]!)
}

function bnTime(now: Date): string {
  return new Intl.DateTimeFormat('bn-BD', {
    timeZone: DHAKA_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now)
}

function minutesBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60_000
}

// ── Snapshot fallback (Imou signed URLs expire ~1hr) ──────────────────────────
async function freshSnapshotUrl(deviceId: string): Promise<string | null> {
  if (!deviceId) return null
  try {
    const { captureImouSnapshot } = await import('@/agent/lib/imou-camera')
    const snap = await captureImouSnapshot(deviceId)
    return snap.url || null
  } catch (err) {
    console.warn('[office-absence] fresh snapshot failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Send a photo to a chat, retrying with a fresh frame then text-only on failure. */
async function sendPhotoResilient(
  chatId: string,
  photoUrl: string,
  caption: string,
  deviceId: string,
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
): Promise<{ ok: boolean; error?: string }> {
  let res = await sendTelegramPhoto(chatId, photoUrl, caption, reply_markup)
  if (!res.ok) {
    const fresh = await freshSnapshotUrl(deviceId)
    if (fresh) res = await sendTelegramPhoto(chatId, fresh, caption, reply_markup)
  }
  if (!res.ok) res = await sendTelegramText(chatId, caption)
  return res
}

// ── The owner alert (Card 1) ──────────────────────────────────────────────────
async function alertOwnerAbsence(opts: {
  peopleCount: number
  expected: number
  absent: number
  sustainedMin: number
  snapshotUrl: string
  deviceId: string
  now: Date
}): Promise<boolean> {
  let actionId: string | null = null
  try {
    const action = await db.agentPendingAction.create({
      data: {
        type: 'office_absence_confirm',
        businessId: BUSINESS_ID,
        payload: {
          photoUrl: opts.snapshotUrl,
          deviceId: opts.deviceId,
          peopleCount: opts.peopleCount,
          expected: opts.expected,
          absent: opts.absent,
          camera: 'Work Room',
        },
        summary: `অফিসে ${toBnNum(opts.absent)} জন স্টাফ কম — মালিকের নিশ্চিতকরণ দরকার`,
        costEstimate: 0,
        status: 'pending',
      },
      select: { id: true },
    })
    actionId = action.id as string
  } catch (err) {
    console.warn('[office-absence] create confirm action failed:', err instanceof Error ? err.message : err)
  }

  const reply_markup = actionId
    ? {
        inline_keyboard: [[
          { text: '✅ হ্যাঁ, পাঠিয়েছি', callback_data: `approve:${actionId}` },
          { text: '❌ না', callback_data: `reject:${actionId}` },
        ]],
      }
    : undefined

  const when = `${bnTime(opts.now)} — একটানা ~${toBnNum(opts.sustainedMin)} মিনিট`
  const caption =
    opts.peopleCount === 0
      ? `🚨 অফিস খালি! ক্যামেরায় কাউকে দেখা যাচ্ছে না।\nWork Room (${when})\n\n` +
        (actionId ? '👇 আপনি কি সবাইকে বাইরে পাঠিয়েছেন?' : '(পাইলট — বাটন তৈরি হয়নি)')
      : `⚠️ ${toBnNum(opts.absent)} জন স্টাফ অফিসে নেই — ${toBnNum(opts.peopleCount)}/${toBnNum(opts.expected)} জন আছে।\n` +
        `Work Room (${when})\n\n` +
        (actionId ? '👇 আপনি কি কাউকে বাইরে পাঠিয়েছেন?' : '(পাইলট — বাটন তৈরি হয়নি)')

  let res = await sendOwnerPhoto(opts.snapshotUrl, caption, reply_markup)
  if (!res.ok) {
    const fresh = await freshSnapshotUrl(opts.deviceId)
    if (fresh) res = await sendOwnerPhoto(fresh, caption, reply_markup)
  }
  if (!res.ok) console.warn('[office-absence] owner alert failed:', res.error)
  return res.ok
}

// ── Main entrypoint (called from runIdleWatch with the analysed frame) ─────────
export interface OfficeAbsenceResult {
  ran: boolean
  reason?: string
  expected?: number
  effectiveExpected?: number
  absent?: number
  snoozed?: boolean
  alerted?: boolean
  sustainedMin?: number
}

/**
 * Evaluate one camera frame's people_count against the expected office head-count
 * and advance the absence episode. Lunch / prayer / office-hours exclusion is the
 * caller's job (runIdleWatch already gates those). Never throws.
 */
export async function checkOfficeAbsence(opts: {
  peopleCount: number
  snapshotUrl: string
  deviceId: string
  now?: Date
}): Promise<OfficeAbsenceResult> {
  const now = opts.now ?? new Date()
  try {
    if (!(await getEnabled())) return { ran: false, reason: 'disabled' }

    const expected = await getExpectedCount()
    const openLunch = await getOpenLunchCount(now)
    const effectiveExpected = Math.max(0, expected - openLunch)
    if (effectiveExpected <= 0) {
      await clearState()
      return { ran: true, reason: 'no_expected', expected, effectiveExpected, absent: 0 }
    }

    const absent = Math.max(0, effectiveExpected - opts.peopleCount)

    // A snooze authorises up to `authorizedAbsent` missing staff. Below that = perfect.
    // 0-present pierces it because absent then equals effectiveExpected (> 1).
    const snooze = await readSnooze(now)
    const authorized = snooze ? snooze.authorizedAbsent : 0
    const breach = absent > authorized

    if (!breach) {
      await clearState()
      return { ran: true, expected, effectiveExpected, absent, snoozed: !!snooze, alerted: false }
    }

    // Episode tracking (sustained breach).
    const state = await readState()
    let underStartedAt = state.underStartedAt ? new Date(state.underStartedAt) : null
    let notifiedAt = state.notifiedAt ? new Date(state.notifiedAt) : null
    const lastSeen = state.lastSeenUnderAt ? new Date(state.lastSeenUnderAt) : null

    // A gap larger than the grace window → the old episode is stale; restart it.
    if (underStartedAt && lastSeen && minutesBetween(now, lastSeen) > GRACE_MIN) {
      underStartedAt = null
      notifiedAt = null
    }
    if (!underStartedAt) {
      underStartedAt = now
      notifiedAt = null
    }

    const sustainedMin = minutesBetween(now, underStartedAt)
    const threshold = await getThresholdMin()
    let alerted = false
    if (sustainedMin >= threshold && !notifiedAt) {
      const ok = await alertOwnerAbsence({
        peopleCount: opts.peopleCount,
        expected: effectiveExpected,
        absent,
        sustainedMin: Math.round(sustainedMin),
        snapshotUrl: opts.snapshotUrl,
        deviceId: opts.deviceId,
        now,
      })
      if (ok) {
        notifiedAt = now
        alerted = true
      }
    }

    await writeState({
      underStartedAt: underStartedAt.toISOString(),
      lastSeenUnderAt: now.toISOString(),
      notifiedAt: notifiedAt ? notifiedAt.toISOString() : undefined,
    })

    return { ran: true, expected, effectiveExpected, absent, snoozed: !!snooze, alerted, sustainedMin: Math.round(sustainedMin) }
  } catch (err) {
    console.warn('[office-absence] check failed:', err instanceof Error ? err.message : err)
    return { ran: false, reason: 'error' }
  }
}

/**
 * One-shot connectivity test: capture a live frame and push a real Card 1 (with
 * working ✅/❌ buttons) to the owner, bypassing thresholds / episode state. Tapping
 * a button drives the real approve/reject handlers → the real snooze / staff-picker
 * follow-ups, so this proves the whole chain end-to-end. Never throws.
 */
export async function runAbsenceWatchTest(
  deviceId = process.env.IMOU_DEVICE_ID ?? '',
): Promise<{ ran: boolean; error?: string; actionSent?: boolean }> {
  try {
    if (!deviceId) return { ran: false, error: 'no_device_id' }
    const { captureImouSnapshot } = await import('@/agent/lib/imou-camera')
    const snap = await captureImouSnapshot(deviceId)
    const ok = await alertOwnerAbsence({
      peopleCount: 1,
      expected: 2,
      absent: 1,
      sustainedMin: 30,
      snapshotUrl: snap.url,
      deviceId,
      now: new Date(),
    })
    return { ran: true, actionSent: ok }
  } catch (err) {
    return { ran: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Follow-up card builders (invoked by the approve/reject route handlers) ─────

/**
 * Owner tapped ✅ হ্যাঁ on the confirm card → offer snooze durations. Each duration
 * is its own pending action so the buttons stay within the approve: contract; the
 * one the owner taps wins and cancels its siblings.
 */
export async function sendAbsenceSnoozeOptions(opts: {
  photoUrl: string
  deviceId: string
}): Promise<{ ok: boolean; error?: string }> {
  const groupId = `absnooze:${Date.now()}`
  const hourOptions = [1, 2, 4]
  const buttons: Array<{ text: string; callback_data: string }> = []
  for (const h of hourOptions) {
    try {
      const action = await db.agentPendingAction.create({
        data: {
          type: 'office_absence_snooze',
          businessId: BUSINESS_ID,
          payload: { hours: h, authorizedAbsent: 1, groupId, photoUrl: opts.photoUrl, deviceId: opts.deviceId },
          summary: `অনুপস্থিতি স্নুজ ${toBnNum(h)} ঘণ্টা`,
          costEstimate: 0,
          status: 'pending',
        },
        select: { id: true },
      })
      buttons.push({ text: `${toBnNum(h)} ঘণ্টা`, callback_data: `approve:${action.id}` })
    } catch (err) {
      console.warn('[office-absence] create snooze option failed:', err instanceof Error ? err.message : err)
    }
  }
  if (buttons.length === 0) return { ok: false, error: 'no_options_created' }

  const caption =
    'ঠিক আছে Boss। কত সময় স্টাফ বাইরে থাকবে? এই সময় পর্যন্ত ১ জন কম থাকলেও সব ঠিক ধরে নেব — ' +
    'এর মধ্যে আর জানাবো না। সময় শেষে আবার চেক করব।'
  return sendPhotoResilient(
    String(process.env.TELEGRAM_OWNER_CHAT_ID ?? ''),
    opts.photoUrl,
    caption,
    opts.deviceId,
    { inline_keyboard: [buttons] },
  )
}

/**
 * Owner tapped ❌ না → he did NOT send anyone out → ask WHICH staffer is missing.
 * The camera can count heads but not name them, so the owner names the absent staff;
 * each active staffer (with a Telegram DM) is one option button.
 */
export async function sendAbsenceStaffPicker(opts: {
  photoUrl: string
  deviceId: string
}): Promise<{ ok: boolean; error?: string }> {
  const staff = (await db.agentStaff.findMany({
    where: { active: true, businessId: BUSINESS_ID, telegramChatId: { not: null } },
    select: { id: true, name: true, telegramChatId: true },
  })) as Array<{ id: string; name: string; telegramChatId: string | null }>

  if (staff.length === 0) {
    return sendPhotoResilient(
      String(process.env.TELEGRAM_OWNER_CHAT_ID ?? ''),
      opts.photoUrl,
      'কোনো অ্যাক্টিভ স্টাফের Telegram পাওয়া যায়নি — তাই কাউকে সরাসরি মেসেজ পাঠানো যাচ্ছে না।',
      opts.deviceId,
    )
  }

  const groupId = `abspick:${Date.now()}`
  const buttons: Array<{ text: string; callback_data: string }> = []
  for (const s of staff) {
    try {
      const action = await db.agentPendingAction.create({
        data: {
          type: 'office_absence_nudge',
          businessId: BUSINESS_ID,
          payload: { staffId: s.id, staffName: s.name, groupId, photoUrl: opts.photoUrl, deviceId: opts.deviceId },
          summary: `অনুপস্থিত স্টাফকে নোটিশ: ${s.name}`,
          costEstimate: 0,
          status: 'pending',
        },
        select: { id: true },
      })
      buttons.push({ text: `📨 ${s.name}`, callback_data: `approve:${action.id}` })
    } catch (err) {
      console.warn('[office-absence] create staff-pick option failed:', err instanceof Error ? err.message : err)
    }
  }
  if (buttons.length === 0) return { ok: false, error: 'no_options_created' }

  // One staffer per row keeps long names readable on the phone.
  const keyboard = buttons.map((b) => [b])
  const caption = 'কোন স্টাফ অফিসে নেই? নাম সিলেক্ট করুন — তাকে ক্যামেরার ছবিসহ মেসেজ পাঠিয়ে দেব।'
  return sendPhotoResilient(
    String(process.env.TELEGRAM_OWNER_CHAT_ID ?? ''),
    opts.photoUrl,
    caption,
    opts.deviceId,
    { inline_keyboard: keyboard },
  )
}

/** Send the absent staffer the camera frame + a Bangla "you're not in office" nudge. */
export async function sendAbsenceNudgeToStaff(opts: {
  staffId: string
  staffName: string
  photoUrl: string
  deviceId: string
}): Promise<{ ok: boolean; error?: string }> {
  const staff = (await db.agentStaff.findUnique({
    where: { id: opts.staffId },
    select: { name: true, telegramChatId: true },
  })) as { name: string; telegramChatId: string | null } | null

  const chatId = (staff?.telegramChatId ?? '').trim()
  if (!chatId) return { ok: false, error: 'no_staff_chat_id' }

  const name = staff?.name ?? opts.staffName
  const message =
    `আসসালামু আলাইকুম ${name}। অফিসের ক্যামেরায় আপনাকে দেখা যাচ্ছে না — এখন কাজের সময়। ` +
    `অনুগ্রহ করে দ্রুত অফিসে ফিরে কাজগুলো শেষ করুন, ইনশাআল্লাহ। ধন্যবাদ 🙏`

  return sendPhotoResilient(chatId, opts.photoUrl, message, opts.deviceId)
}

/**
 * Retire the un-tapped siblings in an option group once one is chosen, so a stray
 * second tap is a harmless no-op (status check already guards re-execution).
 */
export async function cancelAbsenceSiblings(groupId: string, exceptId: string): Promise<void> {
  if (!groupId) return
  try {
    const rows = (await db.agentPendingAction.findMany({
      where: { type: { in: ['office_absence_snooze', 'office_absence_nudge'] }, status: 'pending' },
      select: { id: true, payload: true },
    })) as Array<{ id: string; payload: { groupId?: string } }>
    const ids = rows
      .filter((r) => r.id !== exceptId && r.payload?.groupId === groupId)
      .map((r) => r.id)
    if (ids.length) {
      await db.agentPendingAction.updateMany({
        where: { id: { in: ids } },
        data: { status: 'superseded', resolvedAt: new Date() },
      })
    }
  } catch (err) {
    console.warn('[office-absence] cancel siblings failed:', err instanceof Error ? err.message : err)
  }
}
