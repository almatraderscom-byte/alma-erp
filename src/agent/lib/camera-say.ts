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
import { prisma } from '@/lib/prisma'
import { synthesizeBanglaMp3, googleTtsConfigured } from '@/agent/lib/google-tts'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const MAX_TEXT_CHARS = 300
// Queued jobs older than this are expired, never played (stale-announcement guard).
const QUEUE_TTL_MS = 10 * 60 * 1000
// Signed MP3 URL validity — the bridge downloads immediately after claiming.
const AUDIO_URL_TTL_SEC = 600

const BRIDGE_TOKEN_KEY = 'camera_bridge_token'

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
  const key = (name ?? '').trim().toLowerCase()
  return CAMERA_STREAMS[key] ?? 'workroom'
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
export async function claimNextSpeakJob(): Promise<
  null | { id: string; stream: string; text: string; audioUrl: string }
> {
  try {
    // Expire stale queued jobs first so they can never play hours late.
    await db.agentCameraSpeakJob.updateMany({
      where: { status: 'queued', createdAt: { lt: new Date(Date.now() - QUEUE_TTL_MS) } },
      data: { status: 'failed', error: 'expired', doneAt: new Date() },
    })

    const job = await db.agentCameraSpeakJob.findFirst({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, stream: true, text: true, audioPath: true },
    })
    if (!job) return null

    await db.agentCameraSpeakJob.update({
      where: { id: job.id },
      data: { status: 'delivered', deliveredAt: new Date() },
    })

    const audioUrl = await agentStorageSignedUrl(job.audioPath as string, AUDIO_URL_TTL_SEC)
    return { id: job.id as string, stream: job.stream as string, text: job.text as string, audioUrl }
  } catch (err) {
    console.warn('[camera-say] claim failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Bridge reports playback result. Best-effort — never throws. */
export async function ackSpeakJob(id: string, ok: boolean, error?: string): Promise<void> {
  try {
    await db.agentCameraSpeakJob.update({
      where: { id },
      data: {
        status: ok ? 'done' : 'failed',
        doneAt: new Date(),
        error: ok ? null : (error ?? 'playback failed').slice(0, 500),
      },
    })
  } catch (err) {
    console.warn('[camera-say] ack failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Shared secret the office-PC bridge must present (Bearer token). Lives in KV
 * (agent_kv_settings key 'camera_bridge_token') so the owner can rotate it
 * without a redeploy. Empty string = bridge auth impossible → all polls 401.
 */
export async function getBridgeToken(): Promise<string> {
  try {
    const row = await db.agentKvSetting.findUnique({
      where: { key: BRIDGE_TOKEN_KEY },
      select: { value: true },
    })
    return ((row?.value as string | undefined) ?? '').trim()
  } catch {
    return ''
  }
}
