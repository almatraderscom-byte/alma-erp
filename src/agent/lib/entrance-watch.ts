/**
 * Entrance watch — "কে ঢুকলো / কে বের হলো / অপরিচিত কে?"
 *
 * A 1-minute Vercel cron polls the ENTRANCE camera: capture a frame → cheap
 * Gemini presence scan → if anyone is visible, identify them against the
 * known-people registry (face-match.ts) → alert the owner on TRANSITIONS only:
 *
 *   • a known person newly appears  → "👋 X এন্ট্রান্সে" + frame
 *   • an unrecognized person appears → "🚨 অপরিচিত ব্যক্তি" + frame (Pro-confirmed)
 *
 * Polling one frame a minute cannot tell in/out direction, so alerts say
 * "এন্ট্রান্সে দেখা গেল" and carry the photo — the owner sees the direction.
 * (Event-driven upgrades — Imou alarm callbacks — are a later phase.)
 *
 * State (who is currently visible, last alert times) lives in agent_kv_settings
 * like office-absence. Per-person and stranger cooldowns stop spam when someone
 * lingers at the entrance. Everything is best-effort and never throws to cron.
 *
 * Owner-tunable KV keys (no redeploy):
 *   entrance_watch_enabled     — on/off (default on; skips without a device id)
 *   entrance_camera_device_id  — Imou deviceId of the entrance camera
 *                                (fallback: IMOU_ENTRANCE_DEVICE_ID env)
 *   entrance_watch_start_hm / entrance_watch_end_hm — active window (default 24h)
 *   entrance_alert_cooldown_min — re-alert cooldown per person/stranger (default 10)
 */
import { prisma } from '@/lib/prisma'
import { captureImouSnapshot, downloadSnapshot } from '@/agent/lib/imou-camera'
import { geminiVisionJson } from '@/agent/lib/vision-analyze'
import { identifyPeopleInFrame, type FaceMatchResult } from '@/agent/lib/face-match'
import { sendOwnerPhoto, sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { DHAKA_TZ } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const ENABLED_KEY = 'entrance_watch_enabled'
const DEVICE_KEY = 'entrance_camera_device_id'
const START_KEY = 'entrance_watch_start_hm'
const END_KEY = 'entrance_watch_end_hm'
const COOLDOWN_KEY = 'entrance_alert_cooldown_min'
const STATE_KEY = 'entrance_watch_state'

const DEFAULT_COOLDOWN_MIN = 10
// Someone not seen for this long counts as "gone"; reappearing after → new visit.
const PRESENCE_TTL_MIN = 4

// ── KV helpers (same pattern as office-absence) ───────────────────────────────
async function kvGet(key: string): Promise<string | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value ?? null
  } catch {
    return null
  }
}

export async function kvSetEntrance(key: string, value: string): Promise<void> {
  await db.agentKvSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function getEnabled(): Promise<boolean> {
  const v = (await kvGet(ENABLED_KEY))?.trim().toLowerCase()
  return v !== 'off' && v !== 'false' && v !== '0'
}

export async function getEntranceDeviceId(): Promise<string> {
  return ((await kvGet(DEVICE_KEY)) ?? '').trim() || (process.env.IMOU_ENTRANCE_DEVICE_ID ?? '').trim()
}

async function getCooldownMin(): Promise<number> {
  const n = parseInt((await kvGet(COOLDOWN_KEY)) ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_MIN
}

/** Current entrance settings for the admin page. */
export async function getEntranceSettings(): Promise<{
  enabled: boolean
  deviceId: string
  startHm: string
  endHm: string
  cooldownMin: number
}> {
  return {
    enabled: await getEnabled(),
    deviceId: await getEntranceDeviceId(),
    startHm: ((await kvGet(START_KEY)) ?? '').trim() || '00:00',
    endHm: ((await kvGet(END_KEY)) ?? '').trim() || '23:59',
    cooldownMin: await getCooldownMin(),
  }
}

// ── Time window ───────────────────────────────────────────────────────────────
function dhakaMinutesOfDay(now: Date): number {
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: DHAKA_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now)
  const [h, m] = hm.split(':').map(Number)
  return h! * 60 + m!
}

function parseHm(value: string | null, fallback: number): number {
  if (!value) return fallback
  const [h, m] = value.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback
  return h! * 60 + m!
}

async function inActiveWindow(now: Date): Promise<boolean> {
  const start = parseHm(await kvGet(START_KEY), 0)
  const end = parseHm(await kvGet(END_KEY), 23 * 60 + 59)
  const mins = dhakaMinutesOfDay(now)
  // Support overnight windows (e.g. 20:00–06:00) too.
  return start <= end ? mins >= start && mins <= end : mins >= start || mins <= end
}

// ── Watch state ───────────────────────────────────────────────────────────────
interface EntranceState {
  /** Known name → ISO time last seen at the entrance. */
  presentKnown?: Record<string, string>
  /** Known name → ISO time last alerted. */
  lastAlertKnown?: Record<string, string>
  strangerLastSeenAt?: string
  strangerLastAlertAt?: string
}

async function readState(): Promise<EntranceState> {
  const raw = await kvGet(STATE_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as EntranceState
  } catch {
    return {}
  }
}

async function writeState(s: EntranceState): Promise<void> {
  await kvSetEntrance(STATE_KEY, JSON.stringify(s))
}

function minutesSince(iso: string | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const t = Date.parse(iso)
  return Number.isFinite(t) ? (now.getTime() - t) / 60_000 : Number.POSITIVE_INFINITY
}

// ── Formatting ────────────────────────────────────────────────────────────────
function bnTime(now: Date): string {
  return new Intl.DateTimeFormat('bn-BD', {
    timeZone: DHAKA_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now)
}

// ── Cheap presence scan (no references needed) ────────────────────────────────
interface PresenceScan {
  people_count?: number
}

const PRESENCE_PROMPT = `This is one still frame from an entrance-area CCTV camera (wide-angle, possibly black & white night vision). Count the people visible. Return ONLY JSON: {"people_count": <integer>}`

async function scanPresence(base64: string, mimeType: string): Promise<number> {
  const res = await geminiVisionJson<PresenceScan>({
    prompt: PRESENCE_PROMPT, imageBase64: base64, mimeType,
    costKind: 'vision_entrance_presence', maxTokens: 256,
  })
  return res.people_count ?? 0
}

// ── Main tick ─────────────────────────────────────────────────────────────────
export interface EntranceWatchResult {
  ran: boolean
  skipped?: string
  error?: string
  peopleCount?: number
  identified?: string[]
  strangerPresent?: boolean
  alerts?: string[]
}

export async function runEntranceWatch(deviceIdOverride?: string): Promise<EntranceWatchResult> {
  const now = new Date()
  try {
    if (!(await getEnabled())) return { ran: false, skipped: 'disabled' }
    if (!(await inActiveWindow(now))) return { ran: false, skipped: 'outside_window' }
    const deviceId = deviceIdOverride?.trim() || (await getEntranceDeviceId())
    if (!deviceId) return { ran: false, skipped: 'no_entrance_device' }

    return await captureAnalyzeAlert(deviceId, now)
  } catch (err) {
    return { ran: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Webhook path: min gap between event-triggered snapshots (Imou can fire a burst
// of alarms for one visit — one snapshot per ~20s is plenty and protects quota).
const EVENT_MIN_GAP_SEC = 20
const EVENT_LAST_KEY = 'entrance_event_last_at'
const WEBHOOK_ENABLED_KEY = 'entrance_webhook_enabled'

/**
 * Event-driven entry (Imou alarm webhook): no time window — the whole point is
 * 24h coverage at near-zero polling cost — but rate-limited per EVENT_MIN_GAP_SEC.
 * Shares ALL alert state with the polling path, so running both never double-alerts.
 * Never throws.
 */
export async function runEntranceEvent(deviceId: string): Promise<EntranceWatchResult> {
  const now = new Date()
  try {
    const enabled = ((await kvGet(WEBHOOK_ENABLED_KEY)) ?? 'on').trim().toLowerCase()
    if (enabled === 'off' || enabled === 'false' || enabled === '0') {
      return { ran: false, skipped: 'webhook_disabled' }
    }
    if (!deviceId) return { ran: false, skipped: 'no_device' }

    const last = await kvGet(EVENT_LAST_KEY)
    if (last && (now.getTime() - Date.parse(last)) / 1000 < EVENT_MIN_GAP_SEC) {
      return { ran: false, skipped: 'rate_limited' }
    }
    await kvSetEntrance(EVENT_LAST_KEY, now.toISOString())

    return await captureAnalyzeAlert(deviceId, now)
  } catch (err) {
    return { ran: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Shared core: capture one frame → presence gate → identify against the
 * known-people registry → fire transition alerts. State (who was recently seen,
 * per-person/stranger alert cooldowns) lives in KV and is shared by the 1-min
 * cron AND the Imou event webhook.
 */
async function captureAnalyzeAlert(deviceId: string, now: Date): Promise<EntranceWatchResult> {
  {
    const snap = await captureImouSnapshot(deviceId)
    const { base64, mimeType } = await downloadSnapshot(snap.url)

    const state = await readState()
    const presentKnown = state.presentKnown ?? {}

    // Cheap presence gate: empty frame → nothing to identify (tracked "last seen"
    // timestamps age out on their own, no state write needed).
    const count = await scanPresence(base64, mimeType)
    if (count === 0) {
      return { ran: true, peopleCount: 0, identified: [], strangerPresent: false, alerts: [] }
    }

    // Someone is visible → full identification against the registry.
    const match = await identifyPeopleInFrame({ base64, mimeType })
    const alerts: string[] = []
    const cooldownMin = await getCooldownMin()

    if (!match.hadReferences) {
      // No reference photos registered yet — fall back to a generic person alert
      // (still useful: owner learns someone is at the entrance), same cooldown.
      if (minutesSince(state.strangerLastAlertAt, now) >= cooldownMin) {
        const ok = await sendOwnerAlert(
          `🚪 এন্ট্রান্সে ${count} জনকে দেখা যাচ্ছে (${bnTime(now)})।\n` +
            `চেনা মুখ শনাক্ত করতে /agent/known-people পেজে ছবি যোগ করুন।`,
          snap.url, deviceId,
        )
        if (ok) {
          state.strangerLastAlertAt = now.toISOString()
          alerts.push('unidentified')
        }
      }
      state.strangerLastSeenAt = now.toISOString()
      await writeState(state)
      return { ran: true, peopleCount: count, identified: [], strangerPresent: false, alerts }
    }

    const identifiedNames = match.people.filter((p) => p.known && p.name).map((p) => p.name!) as string[]
    const lastAlertKnown = state.lastAlertKnown ?? {}

    // Known-person transitions: newly appeared (or reappeared after TTL) → alert.
    for (const name of identifiedNames) {
      const seenRecently = minutesSince(presentKnown[name], now) <= PRESENCE_TTL_MIN
      const cooledDown = minutesSince(lastAlertKnown[name], now) >= cooldownMin
      if (!seenRecently && cooledDown) {
        const ok = await sendOwnerAlert(
          `👋 ${name} এন্ট্রান্সে — ঢুকছেন বা বের হচ্ছেন (${bnTime(now)})।` +
            (match.summaryBn ? `\nAI: ${match.summaryBn}` : ''),
          snap.url, deviceId,
        )
        if (ok) {
          lastAlertKnown[name] = now.toISOString()
          alerts.push(`known:${name}`)
        }
      }
      presentKnown[name] = now.toISOString()
    }

    // Stranger transition (Pro-confirmed inside identifyPeopleInFrame).
    if (match.strangerPresent) {
      const strangerSeenRecently = minutesSince(state.strangerLastSeenAt, now) <= PRESENCE_TTL_MIN
      const cooledDown = minutesSince(state.strangerLastAlertAt, now) >= cooldownMin
      if (!strangerSeenRecently && cooledDown) {
        const unknowns = match.people.filter((p) => !p.known)
        const desc = unknowns.map((u) => u.description).filter(Boolean).join('; ')
        const ok = await sendOwnerAlert(
          `🚨 অপরিচিত ব্যক্তি এন্ট্রান্সে! (${bnTime(now)})\n` +
            (desc ? `বর্ণনা: ${desc}\n` : '') +
            (match.summaryBn ? `AI: ${match.summaryBn}` : ''),
          snap.url, deviceId,
        )
        if (ok) {
          state.strangerLastAlertAt = now.toISOString()
          alerts.push('stranger')
        }
      }
      state.strangerLastSeenAt = now.toISOString()
    }

    await writeState({ ...state, presentKnown, lastAlertKnown })
    return {
      ran: true,
      peopleCount: match.peopleCount || count,
      identified: identifiedNames,
      strangerPresent: match.strangerPresent,
      alerts,
    }
  }
}

async function sendOwnerAlert(caption: string, photoUrl: string, deviceId: string): Promise<boolean> {
  let res = await sendOwnerPhoto(photoUrl, caption)
  if (!res.ok) {
    // Signed URL may have just expired — retry once with a fresh frame.
    try {
      const fresh = await captureImouSnapshot(deviceId)
      res = await sendOwnerPhoto(fresh.url, caption)
    } catch { /* fall through to text */ }
  }
  if (!res.ok) res = await sendOwnerText(caption)
  if (!res.ok) console.warn('[entrance-watch] owner alert failed:', res.error)
  return res.ok
}

/**
 * One-shot test (bypasses window/cooldowns/state): capture → identify → push a
 * live card to the owner + return the identification so the admin page can show
 * it. Never throws.
 */
export async function runEntranceWatchTest(deviceIdOverride?: string): Promise<{
  ran: boolean
  error?: string
  peopleCount?: number
  identified?: string[]
  strangerPresent?: boolean
  hadReferences?: boolean
  summaryBn?: string
  telegramSent?: boolean
  telegramError?: string
}> {
  try {
    const deviceId = deviceIdOverride?.trim() || (await getEntranceDeviceId())
    if (!deviceId) return { ran: false, error: 'no_entrance_device' }

    const now = new Date()
    const snap = await captureImouSnapshot(deviceId)
    const { base64, mimeType } = await downloadSnapshot(snap.url)
    const match: FaceMatchResult = await identifyPeopleInFrame({ base64, mimeType })

    const names = match.people.filter((p) => p.known && p.name).map((p) => p.name!)
    const unknownCount = match.people.filter((p) => !p.known).length
    const caption =
      `🧪 এন্ট্রান্স-ওয়াচ টেস্ট (${bnTime(now)})\n` +
      `মানুষ: ${match.peopleCount}` +
      (names.length ? ` | চেনা: ${names.join(', ')}` : '') +
      (unknownCount ? ` | অচেনা: ${unknownCount}` : '') +
      (match.hadReferences ? '' : '\n⚠️ এখনো কোনো রেফারেন্স ছবি যোগ করা হয়নি — শনাক্তকরণ হয়নি।') +
      (match.summaryBn ? `\nAI (${match.model}): ${match.summaryBn}` : '')
    let res = await sendOwnerPhoto(snap.url, caption)
    // Same resilience as the live watch: Telegram sometimes can't fetch the
    // signed snapshot URL — fall back to text so the test still proves the chain.
    if (!res.ok) {
      console.warn('[entrance-watch] test photo send failed:', res.error)
      res = await sendOwnerText(caption)
    }

    return {
      ran: true,
      peopleCount: match.peopleCount,
      identified: names,
      strangerPresent: match.strangerPresent,
      hadReferences: match.hadReferences,
      summaryBn: match.summaryBn,
      telegramSent: res.ok,
      telegramError: res.ok ? undefined : res.error,
    }
  } catch (err) {
    return { ran: false, error: err instanceof Error ? err.message : String(err) }
  }
}
