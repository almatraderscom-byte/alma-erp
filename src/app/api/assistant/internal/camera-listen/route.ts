/**
 * Camera listen endpoint — the staff→owner voice path (Phase 3, Feature 3).
 *
 * Polled/pushed by the OFFICE PC listener (a durable loop next to the camera
 * bridge). The listener pulls the camera's two-way-audio mic (RTSP AAC 16 kHz),
 * does local voice-activity detection so only chunks with speech are sent, and
 * POSTs each speech chunk here. This route:
 *   1. authorizes with the SHARED bridge token (same KV 'camera_bridge_token'
 *      the camera-bridge route uses — the office PC already has it, so no new
 *      secret), timing-safe.
 *   2. transcribes the chunk (Whisper / gpt-4o-transcribe, Bangla) — unless the
 *      caller already did local STT and sent { text } JSON.
 *   3. checks the transcript for a wake word (KV 'camera_wake_words',
 *      default "আলমা শোনো,আলমা,alma"). No wake word → ignored (silent, cheap).
 *   4. on a wake word, strips it and forwards the remaining utterance to the
 *      owner's Telegram, tagged with which room spoke. The owner replies in
 *      chat/Telegram; the head's camera_speak tool speaks the answer back.
 *
 * Two input shapes (both Bearer <bridge token>):
 *   • Raw audio body (Content-Type audio/*) + ?room=entrance  → server STT.
 *   • JSON { text, room }                                     → caller did STT
 *     (also the shape used to verify this route without a mic).
 *
 * KV switches: 'camera_listen_enabled' (default on), 'camera_wake_words',
 * 'camera_listen_cooldown_sec' (default 15 — collapse a burst of chunks into
 * one owner ping).
 */
import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { getBridgeToken } from '@/agent/lib/camera-say'
import { transcribeVoiceBangla } from '@/agent/lib/voice-bangla'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { calcWhisperCostUsd, estimateAudioDurationSeconds } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'

export const runtime = 'nodejs'
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DEFAULT_WAKE_WORDS = 'আলমা শোনো,আলমা,alma'

/**
 * Domain prompt for the camera mic — biases STT toward the wake word and the
 * phrases staff actually say at the office, which matters a lot for distant,
 * echoey CCTV audio. Owner-tunable via KV 'camera_listen_stt_prompt'.
 */
const DEFAULT_STT_PROMPT =
  'অফিসের সিসিটিভি ক্যামেরার মাইক থেকে দূরের বাংলা কথা। ' +
  'প্রায়ই বলা হয়: "আলমা শোনো", "স্যার", "একজন কাস্টমার এসেছে", "একটু আসবেন", ' +
  '"ডেলিভারি এসেছে", "প্যাকেট রেডি"। ' +
  'Bangladeshi Bangla only — not Hindi, not Devanagari.'
const DEFAULT_COOLDOWN_SEC = 15
const COOLDOWN_KEY = 'camera_listen_last_forward_at'

// Room key → Bangla label shown to the owner.
const ROOM_LABELS: Record<string, string> = {
  entrance: 'এন্ট্রান্স',
  gate: 'এন্ট্রান্স',
  গেট: 'এন্ট্রান্স',
  boss: 'বস অফিস',
  বস: 'বস অফিস',
  work: 'ওয়ার্করুম',
  workroom: 'ওয়ার্করুম',
  কাজ: 'ওয়ার্করুম',
}

function roomLabel(room?: string): string {
  const key = (room ?? '').trim().toLowerCase()
  return ROOM_LABELS[key] ?? ROOM_LABELS[(room ?? '').trim()] ?? 'অফিস'
}

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

async function bridgeAuthorized(req: NextRequest): Promise<boolean> {
  const header = req.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!presented) return false
  const expected = await getBridgeToken()
  if (!expected) return false
  try {
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  } catch {
    return false
  }
}

/** Normalize for matching: lowercase, collapse whitespace. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * If the transcript contains a wake word, return the utterance with the wake
 * phrase (and anything before it) stripped; otherwise null.
 */
function matchWake(transcript: string, wakeWords: string[]): string | null {
  const hay = norm(transcript)
  for (const w of wakeWords) {
    const needle = norm(w)
    if (!needle) continue
    const idx = hay.indexOf(needle)
    if (idx !== -1) {
      // Strip everything up to and including the wake phrase, from the ORIGINAL
      // (so we keep original casing/diacritics of the actual message).
      const after = transcript.slice(idx + needle.length)
      return after.replace(/^[\s,।:-]+/, '').trim()
    }
  }
  return null
}

const globalForOpenAI = globalThis as unknown as { openaiCameraListen: OpenAI | undefined }
function openai(): OpenAI {
  if (!globalForOpenAI.openaiCameraListen) {
    globalForOpenAI.openaiCameraListen = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' })
  }
  return globalForOpenAI.openaiCameraListen
}

interface ParsedInput {
  text?: string
  room?: string
  audio?: File
}

async function parseInput(req: NextRequest): Promise<ParsedInput> {
  const contentType = req.headers.get('content-type') ?? ''
  const room = req.nextUrl.searchParams.get('room') ?? undefined

  if (contentType.includes('application/json')) {
    try {
      const body = (await req.json()) as { text?: string; room?: string }
      return { text: body.text, room: body.room ?? room }
    } catch {
      return { room }
    }
  }

  if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') {
    const buf = await req.arrayBuffer()
    if (buf.byteLength === 0) return { room }
    const mime = contentType.split(';')[0].trim() || 'audio/wav'
    const ext = mime.includes('mpeg') ? 'mp3' : mime.includes('wav') ? 'wav' : 'ogg'
    return { audio: new File([buf], `chunk.${ext}`, { type: mime }), room }
  }

  return { room }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!(await bridgeAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const enabled = ((await kvGet('camera_listen_enabled')) ?? 'on').toLowerCase() !== 'off'
  if (!enabled) return NextResponse.json({ ok: true, ignored: 'disabled' })

  const input = await parseInput(req)

  // Resolve the transcript — either provided text or server-side Whisper.
  let transcript = (input.text ?? '').trim()
  if (!transcript && input.audio) {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ ok: true, ignored: 'no_stt_key' })
    }
    if (input.audio.size > 25 * 1024 * 1024) {
      return NextResponse.json({ ok: true, ignored: 'audio_too_large' })
    }
    try {
      const sttPrompt = (await kvGet('camera_listen_stt_prompt')) ?? DEFAULT_STT_PROMPT
      const t = await transcribeVoiceBangla(openai(), input.audio, sttPrompt)
      transcript = (t.text ?? '').trim()
      const durationSec = estimateAudioDurationSeconds(input.audio.size)
      void logCost({
        provider: 'openai',
        kind: 'transcribe',
        units: { duration_seconds: durationSec, bytes: input.audio.size, model: t.model, purpose: 'camera_listen' },
        costUsd: calcWhisperCostUsd(durationSec),
        dedupKey: `camlisten:${input.audio.size}:${transcript.slice(0, 20)}`,
      })
    } catch (err) {
      console.warn('[camera-listen] STT failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ ok: true, ignored: 'stt_error' })
    }
  }

  if (!transcript) return NextResponse.json({ ok: true, ignored: 'empty' })

  const wakeWords = ((await kvGet('camera_wake_words')) ?? DEFAULT_WAKE_WORDS)
    .split(',').map((s) => s.trim()).filter(Boolean)
  const utterance = matchWake(transcript, wakeWords)
  if (utterance === null) {
    // No wake word — heard speech but not addressed to us. Silent + cheap.
    return NextResponse.json({ ok: true, heard: transcript, matched: false })
  }

  // Cooldown: a burst of chunks around one sentence should ping the owner once.
  const cooldownSec = Number((await kvGet('camera_listen_cooldown_sec')) ?? DEFAULT_COOLDOWN_SEC) || DEFAULT_COOLDOWN_SEC
  const lastRaw = await kvGet(COOLDOWN_KEY)
  const now = Date.now()
  if (lastRaw) {
    const last = Date.parse(lastRaw)
    if (Number.isFinite(last) && now - last < cooldownSec * 1000) {
      return NextResponse.json({ ok: true, heard: transcript, matched: true, forwarded: false, reason: 'cooldown' })
    }
  }

  const label = roomLabel(input.room)
  const spoken = utterance || '(শুধু ডাকলো, কিছু বললো না)'
  const msg = `🎤 ${label} ক্যামেরায় স্টাফ ডাকলো:\n\n«${spoken}»\n\nউত্তর দিলে বলুন — "${input.room ?? 'work'} ক্যামেরায় বলো: …" — আমি স্পিকারে বলে দেবো, Sir।`

  const res = await sendOwnerText(msg)
  if (res.ok) await kvSet(COOLDOWN_KEY, new Date(now).toISOString())

  return NextResponse.json({ ok: true, heard: transcript, matched: true, forwarded: res.ok, error: res.error })
}

// Health probe for the office-PC listener.
export async function GET() {
  return NextResponse.json({ ok: true })
}
