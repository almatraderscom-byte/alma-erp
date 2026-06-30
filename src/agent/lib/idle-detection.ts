// Staff idle-detection pilot. Runs on a 5-minute Vercel cron during office hours:
// pull a snapshot from the office camera → Gemini vision flags off-task behaviour
// → a per-category "episode" tracks how long it has been sustained → when it
// crosses the owner-set threshold (and we are NOT in a lunch/prayer window) the
// owner gets a Telegram photo alert. Everything is best-effort and never throws to
// the cron caller.
//
// Owner-tunable via agent_kv_settings (no redeploy). Categories for the pilot:
//   • away_mobile    — sitting away from the desk / lying down using a phone  (15 min)
//   • monitor_video  — a monitor visibly showing YouTube / entertainment      (5 min)
//   • group_chatting — staff gathered together chatting ("adda")              (10 min)
import { prisma } from '@/lib/prisma'
import { geminiVisionJson } from '@/agent/lib/vision-analyze'
import { captureImouSnapshot, downloadSnapshot } from '@/agent/lib/imou-camera'
import { sendOwnerPhoto } from '@/agent/lib/telegram-owner-notify'
import { getDhakaPrayerTimes } from '@/agent/lib/salah-times'
import { isWithinDutyWindow } from '@/lib/salah/duty-window'
import { DHAKA_TZ } from '@/lib/agent-api/dhaka-date'

// Tolerate one missed/occluded frame before an episode's timer resets (cron = 5 min).
const GRACE_MIN = 11

interface FrameAnalysis {
  people_count?: number
  away_from_desk_mobile?: boolean
  monitor_entertainment?: boolean
  group_chatting?: boolean
  confidence?: number
  summary_bn?: string
}

interface CategoryDef {
  key: 'away_mobile' | 'monitor_video' | 'group_chatting'
  flag: keyof FrameAnalysis
  defaultMin: number
  thresholdKey: string
  minConfidence: number
  emoji: string
  labelBn: string
}

const CATEGORIES: CategoryDef[] = [
  { key: 'away_mobile', flag: 'away_from_desk_mobile', defaultMin: 15, thresholdKey: 'idle_threshold_away_mobile_min', minConfidence: 0.45, emoji: '📱', labelBn: 'ডেস্কে নেই / শুয়ে আছে / মোবাইল' },
  { key: 'monitor_video', flag: 'monitor_entertainment', defaultMin: 5, thresholdKey: 'idle_threshold_monitor_video_min', minConfidence: 0.6, emoji: '🎬', labelBn: 'মনিটরে ভিডিও/ইউটিউব দেখা' },
  { key: 'group_chatting', flag: 'group_chatting', defaultMin: 10, thresholdKey: 'idle_threshold_group_chatting_min', minConfidence: 0.5, emoji: '💬', labelBn: 'একসাথে বসে আড্ডা' },
]

const VISION_PROMPT = `You are monitoring an office work room through a wide-angle (fisheye) ceiling CCTV camera. This is a single still frame and may be black & white (night-vision). The lens distorts the room, so people can appear near the floor or the edges of the frame. Staff are expected to be SITTING UPRIGHT at their computer desks and working.

Look VERY carefully at each person's BODY POSTURE and LOCATION before deciding. Specifically check:
- Is the person sitting upright at a desk facing a computer? (working)
- Is the person LYING DOWN, reclining, or slumped on the floor, a sofa, or across chairs? (off-task)
- Is the person standing or sitting idle AWAY from any computer desk? (off-task)
- Are two or more people gathered close together facing each other? (chatting)

Analyze the frame for off-task / idle behaviour and return ONLY this JSON (no prose):
{
  "people_count": <integer>,
  "away_from_desk_mobile": <true if ANY person is lying down / reclining / slumped on the floor or sofa, OR is clearly away from their computer desk and not working — whether or not a phone is visible>,
  "monitor_entertainment": <true ONLY if you can clearly see a computer monitor showing entertainment video — YouTube, a movie, social/short video — rather than work content>,
  "group_chatting": <true if two or more people are gathered close together chatting/socialising instead of working>,
  "confidence": <0.0 to 1.0 overall confidence>,
  "summary_bn": "<one short factual Bengali sentence describing ONLY what is visibly happening — body posture and location>"
}

Rules:
- Describe ONLY what you can actually see. NEVER invent or guess a person's name. NEVER claim someone is "working on a laptop" or "looking at the screen" unless that is clearly visible.
- A person lying on the floor or reclining is OFF-TASK even if no phone is visible.
- Eating food while seated at a desk is NOT idle.
- A person seated upright at their desk facing a monitor is working — NOT idle.
- If you are genuinely unsure about a flag, set it to false but lower the confidence accordingly.
- An empty room: all flags false, people_count 0.`

// Stronger model used to confirm a suspected-idle frame before we trust it enough
// to start/advance an episode or alert the owner. Flash is cheap and scans every
// frame; Pro only runs on the rare frames Flash flags — so cost stays near Flash.
const CONFIRM_MODEL = 'gemini-2.5-pro'

/**
 * Two-step frame analysis. Always runs the cheap Flash scan. If Flash flags ANY
 * idle category, re-runs the SAME image through the stronger Pro model and trusts
 * that result instead — this is what kills the "lying on the floor → working"
 * misread without paying Pro prices on every clear frame. Falls back to the Flash
 * read if the Pro pass errors, so a frame is never dropped.
 */
async function analyzeFrame(
  base64: string,
  mimeType: string,
): Promise<{ analysis: FrameAnalysis; model: 'flash' | 'pro' }> {
  const flash = await geminiVisionJson<FrameAnalysis>({
    prompt: VISION_PROMPT, imageBase64: base64, mimeType, costKind: 'vision_idle_detection',
  })
  const flagged = CATEGORIES.some((c) => flash[c.flag] === true)
  if (!flagged) return { analysis: flash, model: 'flash' }
  try {
    const pro = await geminiVisionJson<FrameAnalysis>({
      prompt: VISION_PROMPT, imageBase64: base64, mimeType,
      costKind: 'vision_idle_detection_confirm', model: CONFIRM_MODEL,
    })
    return { analysis: pro, model: 'pro' }
  } catch {
    return { analysis: flash, model: 'flash' }
  }
}

// ── KV settings ───────────────────────────────────────────────────────────────
async function kvGet(key: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value ?? null
  } catch {
    return null
  }
}

async function isEnabled(): Promise<boolean> {
  const v = (await kvGet('idle_detection_enabled'))?.trim().toLowerCase()
  return v !== 'off' && v !== 'false' && v !== '0'
}

async function thresholdMin(def: CategoryDef): Promise<number> {
  const v = await kvGet(def.thresholdKey)
  const n = v ? parseInt(v, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : def.defaultMin
}

// ── Time-window exclusions ──────────────────────────────────────────────────────
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

async function isOfficeHours(now: Date): Promise<boolean> {
  const start = parseHm(await kvGet('idle_office_start_hm'), 9 * 60 + 30) // 09:30
  const end = parseHm(await kvGet('idle_office_end_hm'), 20 * 60)         // 20:00
  const mins = dhakaMinutesOfDay(now)
  return mins >= start && mins <= end
}

async function isLunchWindow(now: Date): Promise<boolean> {
  const win = (await kvGet('idle_lunch_window')) ?? '13:00-14:30'
  const [a, b] = win.split('-')
  const start = parseHm(a ?? null, 13 * 60)
  const end = parseHm(b ?? null, 14 * 60 + 30)
  const mins = dhakaMinutesOfDay(now)
  return mins >= start && mins <= end
}

async function isPrayerWindow(now: Date): Promise<boolean> {
  try {
    const waqts = await getDhakaPrayerTimes()
    return waqts.some((w) => isWithinDutyWindow(w.prayerStart, now))
  } catch {
    return false // never block detection on a salah lookup failure
  }
}

/** Reason string if detection should be SKIPPED right now, else null. */
async function excludedReason(now: Date): Promise<string | null> {
  if (!(await isOfficeHours(now))) return 'outside_office_hours'
  if (await isLunchWindow(now)) return 'lunch_window'
  if (await isPrayerWindow(now)) return 'prayer_window'
  return null
}

// ── Episode state machine ───────────────────────────────────────────────────────
interface IdleEpisodeRow {
  id: string
  category: string
  startedAt: Date
  lastSeenAt: Date
  notifiedAt: Date | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function episodes() { return (prisma as any).idleEpisode }

function minutesBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60_000
}

export interface IdleWatchResult {
  ran: boolean
  skipped?: string
  peopleCount?: number
  flags?: Record<string, boolean>
  alerts: string[]
  error?: string
}

/**
 * One cron tick. Pulls a snapshot, analyses it, advances per-category episodes and
 * fires an owner alert when a category stays active past its threshold. Returns a
 * small summary for the cron response/logs. Never throws.
 */
export async function runIdleWatch(deviceId = process.env.IMOU_DEVICE_ID ?? ''): Promise<IdleWatchResult> {
  const now = new Date()
  const result: IdleWatchResult = { ran: false, alerts: [] }
  try {
    if (!(await isEnabled())) return { ...result, skipped: 'disabled' }
    const skip = await excludedReason(now)
    if (skip) return { ...result, skipped: skip }
    if (!deviceId) return { ...result, error: 'no_device_id' }

    const snap = await captureImouSnapshot(deviceId)
    const { base64, mimeType } = await downloadSnapshot(snap.url)
    const { analysis } = await analyzeFrame(base64, mimeType)

    result.ran = true
    result.peopleCount = analysis.people_count ?? 0
    result.flags = {}
    const conf = typeof analysis.confidence === 'number' ? analysis.confidence : 0.5
    const summaryBn = (analysis.summary_bn ?? '').slice(0, 200)

    for (const cat of CATEGORIES) {
      const observed = analysis[cat.flag] === true && conf >= cat.minConfidence
      result.flags[cat.key] = observed

      let open: IdleEpisodeRow | null = await episodes().findFirst({
        where: { category: cat.key, deviceId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      })

      // Stale episode (a gap larger than the grace window) → close it first.
      if (open && minutesBetween(now, open.lastSeenAt) > GRACE_MIN) {
        await episodes().update({ where: { id: open.id }, data: { endedAt: open.lastSeenAt } })
        open = null
      }

      if (observed) {
        if (!open) {
          open = await episodes().create({
            data: { category: cat.key, deviceId, startedAt: now, lastSeenAt: now, snapshotUrl: snap.url, note: summaryBn },
          })
        } else {
          await episodes().update({ where: { id: open.id }, data: { lastSeenAt: now, snapshotUrl: snap.url, note: summaryBn } })
        }

        const sustainedMin = minutesBetween(now, open!.startedAt)
        const threshold = await thresholdMin(cat)
        if (sustainedMin >= threshold && !open!.notifiedAt) {
          const sent = await alertOwner(cat, Math.round(sustainedMin), snap.url, summaryBn, now)
          if (sent) {
            await episodes().update({ where: { id: open!.id }, data: { notifiedAt: now } })
            result.alerts.push(cat.key)
          }
        }
      } else if (open) {
        // Condition cleared this frame → close the episode.
        await episodes().update({ where: { id: open.id }, data: { endedAt: now } })
      }
    }

    return result
  } catch (err) {
    return { ...result, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * One-shot connectivity test: capture → analyse → push the frame + AI verdict to
 * the owner's Telegram immediately, bypassing time windows, thresholds and episode
 * state. Used to prove the whole chain after env is configured. Never throws.
 */
export async function runIdleWatchTest(deviceId = process.env.IMOU_DEVICE_ID ?? ''): Promise<IdleWatchResult> {
  const now = new Date()
  try {
    if (!deviceId) return { ran: false, alerts: [], error: 'no_device_id' }
    const snap = await captureImouSnapshot(deviceId)
    const { base64, mimeType } = await downloadSnapshot(snap.url)
    const { analysis, model } = await analyzeFrame(base64, mimeType)
    const flags = {
      away_mobile: analysis.away_from_desk_mobile === true,
      monitor_video: analysis.monitor_entertainment === true,
      group_chatting: analysis.group_chatting === true,
    }
    const timeLabel = new Intl.DateTimeFormat('bn-BD', {
      timeZone: DHAKA_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(now)
    const caption =
      `🧪 idle-detection টেস্ট — Work Room (${timeLabel})\n` +
      `মানুষ: ${analysis.people_count ?? 0} | মোবাইল: ${flags.away_mobile ? 'হ্যাঁ' : 'না'} | ` +
      `ভিডিও: ${flags.monitor_video ? 'হ্যাঁ' : 'না'} | আড্ডা: ${flags.group_chatting ? 'হ্যাঁ' : 'না'}\n` +
      (analysis.summary_bn ? `\nAI (${model}): ${analysis.summary_bn}` : '')
    const res = await sendOwnerPhoto(snap.url, caption)
    return { ran: true, peopleCount: analysis.people_count ?? 0, flags, alerts: res.ok ? ['test'] : [], error: res.ok ? undefined : `telegram: ${res.error}` }
  } catch (err) {
    return { ran: false, alerts: [], error: err instanceof Error ? err.message : String(err) }
  }
}

async function alertOwner(
  cat: CategoryDef,
  sustainedMin: number,
  snapshotUrl: string,
  summaryBn: string,
  now: Date,
): Promise<boolean> {
  const timeLabel = new Intl.DateTimeFormat('bn-BD', {
    timeZone: DHAKA_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now)
  const caption =
    `${cat.emoji} সম্ভাব্য idle — Work Room\n` +
    `${cat.labelBn}\n` +
    `একটানা ~${sustainedMin} মিনিট ধরে (${timeLabel})\n` +
    (summaryBn ? `\nAI: ${summaryBn}\n` : '') +
    `\n(পাইলট — ভুল হলে জানাবেন, threshold ঠিক করে দেব)`
  const res = await sendOwnerPhoto(snapshotUrl, caption)
  if (!res.ok) console.warn('[idle-watch] owner photo alert failed:', res.error)
  return res.ok
}
