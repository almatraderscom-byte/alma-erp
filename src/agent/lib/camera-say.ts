/**
 * Camera speak — "ক্যামেরার স্পিকারে ঘোষণা দাও"
 *
 * Server side of the camera-speaker announcement pipeline. Vercel cannot reach
 * the office cameras (they sit on the office LAN), so playback is split in two:
 *
 *   1. HERE (Vercel): owner/head agent queues an announcement → Bangla text is
 *      synthesized with the agent voice (google-tts.ts) → MP3 goes to the
 *      agent-files bucket → an AgentCameraSpeakJob row is created ('queued').
 *   2. OFFICE PC: a tiny bridge script polls /api/assistant/internal/camera-bridge with
 *      a bearer token (KV 'camera_bridge_token'), claims the oldest queued job
 *      (signed MP3 URL, 10 min validity), pushes the audio into the chosen
 *      go2rtc stream (camera two-way-audio backchannel), then POSTs an ack.
 *
 * Safety: a queued job older than 10 minutes is expired instead of delivered —
 * if the office PC was offline for hours, stale announcements must NEVER
 * suddenly blare out of a camera when it comes back. Claim/ack are best-effort
 * (never throw) because the bridge polls like a cron.
 */
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { synthesizeBanglaMp3, googleTtsConfigured } from '@/agent/lib/google-tts'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import { cameraLeaseTokenRequired } from '@/agent/lib/camera-auth'
import { canonicalCameraRoom } from '@/agent/lib/camera-voice-policy'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const MAX_TEXT_CHARS = 300
// Queued jobs older than this are expired, never played (stale-announcement guard).
const QUEUE_TTL_MS = 10 * 60 * 1000
// A crashed bridge gets this long to download and hand the audio to go2rtc.
const CLAIM_LEASE_MS = 2 * 60 * 1000
// Signed MP3 URL validity — the bridge downloads immediately after claiming.
const AUDIO_URL_TTL_SEC = 600

/**
 * Friendly names (English + Bangla, as the owner might type them) → go2rtc
 * stream names configured on the office PC. Keys are matched lowercase.
 */
export const CAMERA_STREAMS: Record<string, string> = {
  work: 'workroom',
  workroom: 'workroom',
  'কাজ': 'workroom',
  entrance: 'entrance',
  'গেট': 'entrance',
  'ঢোকার': 'entrance',
  boss: 'boss',
  'বস': 'boss',
  'মালিক': 'boss',
}

/** Resolve a friendly camera name to a go2rtc stream (default 'workroom'). */
export function resolveStream(name?: string): string {
  return canonicalCameraRoom(name)
}

/**
 * Queue an announcement: synthesize Bangla MP3 → upload to agent-files →
 * create a 'queued' job for the office-PC bridge. Throws on bad input or
 * synthesis/upload failure (callers surface the error to the owner).
 */
export async function queueCameraSpeak(
  input: { text: string; camera?: string },
): Promise<{ jobId: string; stream: string }> {
  const text = (input.text ?? '').trim().slice(0, MAX_TEXT_CHARS)
  if (!text) throw new Error('empty text')
  if (!googleTtsConfigured()) throw new Error('GOOGLE_TTS_CREDENTIALS not configured')

  const stream = resolveStream(input.camera)
  const audio = await synthesizeBanglaMp3(text, 'camera_speak')
  const objectPath = `camera-say/${Date.now()}.mp3`
  await agentStorageUpload(objectPath, audio, 'audio/mpeg', { upsert: true })

  const job = await db.agentCameraSpeakJob.create({
    data: { stream, text, audioPath: objectPath, status: 'queued' },
    select: { id: true },
  })
  return { jobId: job.id as string, stream }
}

/**
 * Claim the oldest queued job for the bridge: mark it 'delivered' and return a
 * short-lived signed MP3 URL. Jobs that sat queued past the TTL are marked
 * 'failed' (error 'expired') instead of returned. Never throws — the bridge
 * poll must not 500 on a transient DB/storage hiccup; it just retries.
 */
async function reapSpeakJobs(now = new Date()): Promise<void> {
  const staleBefore = new Date(now.getTime() - QUEUE_TTL_MS)
  const legacyLeaseBefore = new Date(now.getTime() - CLAIM_LEASE_MS)

  // No queued/delivered announcement may survive beyond the ten-minute safety window.
  await db.agentCameraSpeakJob.updateMany({
    where: { status: { in: ['queued', 'delivered'] }, createdAt: { lt: staleBefore } },
    data: {
      status: 'failed',
      error: 'expired',
      doneAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  })

  // Recover a bridge crash. The legacy deliveredAt clause covers claims created
  // before this migration; new claims use an explicit expiry timestamp.
  await db.agentCameraSpeakJob.updateMany({
    where: {
      status: 'delivered',
      createdAt: { gte: staleBefore },
      OR: [
        { leaseExpiresAt: { lt: now } },
        { leaseExpiresAt: null, deliveredAt: { lt: legacyLeaseBefore } },
      ],
    },
    data: {
      status: 'queued',
      error: 'lease_recovered',
      deliveredAt: null,
      doneAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  })
}

export interface ClaimedCameraSpeakJob {
  id: string
  stream: string
  text: string
  audioUrl: string
  leaseToken: string
  leaseExpiresAt: string
}

export async function claimNextSpeakJob(): Promise<null | ClaimedCameraSpeakJob> {
  try {
    const now = new Date()
    await reapSpeakJobs(now)

    // findFirst + conditional updateMany is an optimistic atomic claim. If two
    // bridge polls race, only one transition from queued → delivered can win.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await db.agentCameraSpeakJob.findFirst({
        where: { status: 'queued', createdAt: { gte: new Date(now.getTime() - QUEUE_TTL_MS) } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, stream: true, text: true, audioPath: true },
      })
      if (!job) return null

      const leaseToken = randomUUID()
      const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS)
      const claimed = await db.agentCameraSpeakJob.updateMany({
        where: { id: job.id, status: 'queued' },
        data: {
          status: 'delivered',
          error: null,
          deliveredAt: now,
          leaseToken,
          leaseExpiresAt,
          attemptCount: { increment: 1 },
        },
      })
      if (claimed.count !== 1) continue

      try {
        const audioUrl = await agentStorageSignedUrl(job.audioPath as string, AUDIO_URL_TTL_SEC)
        return {
          id: job.id as string,
          stream: job.stream as string,
          text: job.text as string,
          audioUrl,
          leaseToken,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        }
      } catch (err) {
        // Release only our own claim. A later successful lease can never be reset.
        await db.agentCameraSpeakJob.updateMany({
          where: { id: job.id, status: 'delivered', leaseToken },
          data: {
            status: 'queued',
            error: 'signed_url_failed',
            deliveredAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        })
        throw err
      }
    }
    return null
  } catch (err) {
    console.warn('[camera-say] claim failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface CameraSpeakAckResult {
  accepted: boolean
  alreadyAcked?: boolean
  reason?: 'not_found' | 'lease_token_required' | 'lease_token_mismatch' | 'lease_expired' | 'not_delivered' | 'claim_changed' | 'internal_error'
}

/** Bridge reports whether go2rtc accepted the playback command. Best-effort — never throws. */
export async function ackSpeakJob(
  id: string,
  ok: boolean,
  error?: string,
  presentedLeaseToken?: string,
): Promise<CameraSpeakAckResult> {
  try {
    const leaseRequired = await cameraLeaseTokenRequired()
    if (leaseRequired && !presentedLeaseToken) {
      return { accepted: false, reason: 'lease_token_required' }
    }

    const job = await db.agentCameraSpeakJob.findUnique({
      where: { id },
      select: { status: true, leaseToken: true, leaseExpiresAt: true },
    })
    if (!job) return { accepted: false, reason: 'not_found' }
    if (presentedLeaseToken && presentedLeaseToken !== job.leaseToken) {
      return { accepted: false, reason: 'lease_token_mismatch' }
    }
    if (job.status === 'done' || job.status === 'failed') {
      return { accepted: true, alreadyAcked: true }
    }
    if (job.status !== 'delivered') return { accepted: false, reason: 'not_delivered' }
    if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() < Date.now()) {
      return { accepted: false, reason: 'lease_expired' }
    }

    const updated = await db.agentCameraSpeakJob.updateMany({
      where: { id, status: 'delivered', leaseToken: job.leaseToken },
      data: {
        status: ok ? 'done' : 'failed',
        doneAt: new Date(),
        error: ok ? null : (error ?? 'playback failed').slice(0, 500),
      },
    })
    return updated.count === 1
      ? { accepted: true }
      : { accepted: false, reason: 'claim_changed' }
  } catch (err) {
    console.warn('[camera-say] ack failed:', err instanceof Error ? err.message : err)
    return { accepted: false, reason: 'internal_error' }
  }
}

/**
 * Outcome sweep — tell the owner what actually happened to each announcement,
 * exactly once (notifiedAt). Runs from two cheap call sites: the camera-bridge
 * poll (bridge alive → "✅ বেজেছে" lands seconds after playback) and the 1-min
 * entrance-watch cron (bridge DEAD → queued jobs are expired here and the owner
 * learns "⚠️ বাজেনি — অফিসের PC বন্ধ" instead of silence). This exists because
 * a queued-but-never-played announcement once looked identical to success.
 * Never throws; caps at 5 notifications per run.
 */
export async function sweepAndNotifySpeakJobs(): Promise<void> {
  try {
    await reapSpeakJobs()

    const jobs = (await db.agentCameraSpeakJob.findMany({
      where: {
        status: { in: ['done', 'failed'] },
        notifiedAt: null,
        // Only recent history — never resurface ancient jobs after downtime.
        createdAt: { gt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'asc' },
      take: 5,
      select: { id: true, status: true, error: true, text: true, stream: true },
    })) as Array<{ id: string; status: string; error: string | null; text: string; stream: string }>

    if (jobs.length === 0) return
    const { sendOwnerText } = await import('@/agent/lib/telegram-owner-notify')

    for (const job of jobs) {
      const snippet = job.text.length > 60 ? `${job.text.slice(0, 60)}…` : job.text
      const message =
        job.status === 'done'
          ? `✅ ক্যামেরা ব্রিজ প্লেব্যাক কমান্ড গ্রহণ করেছে (${job.stream}):\n"${snippet}"\n\nমানুষ শুনেছে কি না সফটওয়্যার থেকে নিশ্চিত করা যায় না।`
          : job.error === 'expired'
            ? `⚠️ ঘোষণাটা বাজেনি — অফিসের PC/ব্রিজ বন্ধ ছিল, তাই ১০ মিনিট পর নিরাপদে বাতিল হয়েছে:\n"${snippet}"`
            : `⚠️ ঘোষণাটা বাজানো যায়নি (${job.error ?? 'unknown'}):\n"${snippet}"`
      const res = await sendOwnerText(message)
      if (!res.ok) {
        console.warn('[camera-say] outcome notify failed:', res.error)
        continue
      }
      await db.agentCameraSpeakJob.update({ where: { id: job.id }, data: { notifiedAt: new Date() } })
    }
  } catch (err) {
    console.warn('[camera-say] sweep failed:', err instanceof Error ? err.message : err)
  }
}
