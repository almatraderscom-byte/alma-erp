/**
 * Camera listen endpoint — the staff→owner voice path (Phase 3, Feature 3).
 *
 * Polled/pushed by the OFFICE PC listener (a durable loop next to the camera
 * bridge). The listener pulls the camera's two-way-audio mic (RTSP AAC 16 kHz),
 * does local voice-activity detection so only chunks with speech are sent, and
 * POSTs each speech chunk here. This route:
 *   1. authorizes with the listener token (KV 'camera_listener_token'), falling
 *      back to the shared bridge token until the office-PC script is upgraded.
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
import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { cameraRequestAuthorized } from '@/agent/lib/camera-auth'
import { recordCameraHeartbeat } from '@/agent/lib/camera-health'
import {
  cameraCooldownKey,
  cameraRoomLabel,
  canonicalCameraRoom,
  declaredAudioTooLarge,
  matchCameraWake,
} from '@/agent/lib/camera-voice-policy'
import { transcribeVoiceBangla } from '@/agent/lib/voice-bangla'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { calcWhisperCostUsd, estimateAudioDurationSeconds } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'

export const runtime = 'nodejs'
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// Only the full two-word wake phrase — bare "আলমা"/"alma" was a single short
// token that matched far too easily (and that STT hallucinated), so it is gone.
const DEFAULT_WAKE_WORDS = 'আলমা শোনো'

/**
 * Domain prompt for the camera mic — a NEUTRAL Bangla/anti-Hindi steer only.
 *
 * It deliberately does NOT list the wake word or the phrases staff say. A biased
 * prompt (the old version primed "আলমা শোনো", "একজন কাস্টমার এসেছে", …) makes
 * Whisper HALLUCINATE those exact phrases out of distant, echoey CCTV noise —
 * which manufactured fake wake words and spammed the owner all day. Keep this
 * generic. Owner-tunable via KV 'camera_listen_stt_prompt'.
 */
const DEFAULT_STT_PROMPT =
  'অফিসের সিসিটিভি ক্যামেরার মাইক থেকে দূরের বাংলা কথা। ' +
  'Bangladeshi Bangla only — not Hindi, not Devanagari.'
const DEFAULT_COOLDOWN_SEC = 15
// Hard daily ceiling on paid STT calls from this listener, so a mis-tuned
// silence gate or a stuck loop can never run up an unbounded OpenAI bill.
// Owner-tunable via KV 'camera_listen_daily_cap'.
const DEFAULT_DAILY_STT_CAP = 400
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

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

  const auth = await cameraRequestAuthorized(req.headers, 'listener')
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (declaredAudioTooLarge(req.headers.get('content-length'), MAX_AUDIO_BYTES)) {
    return NextResponse.json({ error: 'audio_too_large' }, { status: 413 })
  }

  // Default OFF. The listener stays silent (and free) until the owner explicitly
  // turns it on via KV 'camera_listen_enabled=on'. This is the kill switch for the
  // runaway-cost incident: even if the office-PC loop keeps POSTing, we bail here
  // BEFORE any paid transcription runs.
  const enabled = ((await kvGet('camera_listen_enabled')) ?? 'off').toLowerCase() === 'on'
  if (!enabled) return NextResponse.json({ ok: true, ignored: 'disabled' })

  const input = await parseInput(req)
  const room = canonicalCameraRoom(input.room)
  await recordCameraHeartbeat({ component: 'listener', room })

  // Resolve the transcript — either provided text or server-side Whisper.
  let transcript = (input.text ?? '').trim()
  if (!transcript && input.audio) {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ ok: true, ignored: 'no_stt_key' })
    }
    if (input.audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: 'audio_too_large' }, { status: 413 })
    }
    // Hard daily ceiling on paid STT calls. Every non-silent chunk costs a Whisper
    // call BEFORE we know if the wake word was said, so a busy room can bleed all
    // day; this caps that bleed at a known number the owner can tune.
    const cap = Number((await kvGet('camera_listen_daily_cap')) ?? DEFAULT_DAILY_STT_CAP) || DEFAULT_DAILY_STT_CAP
    const dayKey = `camera_listen_stt_count:${new Date().toISOString().slice(0, 10)}`
    const usedToday = Number((await kvGet(dayKey)) ?? 0) || 0
    if (usedToday >= cap) {
      return NextResponse.json({ ok: true, ignored: 'daily_stt_cap', usedToday, cap })
    }
    try {
      const sttPrompt = (await kvGet('camera_listen_stt_prompt')) ?? DEFAULT_STT_PROMPT
      const t = await transcribeVoiceBangla(openai(), input.audio, sttPrompt)
      transcript = (t.text ?? '').trim()
      await kvSet(dayKey, String(usedToday + 1))
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

  // Echo guard: right after an announcement plays, the camera mic hears the
  // camera's own speaker — and STT (biased toward the wake word) can
  // hallucinate a match from that echo. Ignore AUDIO-derived transcripts for a
  // short window after a successful playback command in the SAME room (text
  // input is unaffected).
  if (input.audio) {
    const echoSec = Number((await kvGet('camera_listen_echo_guard_sec')) ?? 60) || 60
    try {
      const recentSpeak = await db.agentCameraSpeakJob.findFirst({
        where: {
          stream: room,
          status: 'done',
          doneAt: { gte: new Date(Date.now() - echoSec * 1000) },
        },
        select: { id: true },
      })
      if (recentSpeak) {
        return NextResponse.json({ ok: true, heard: transcript, ignored: 'echo_guard' })
      }
    } catch { /* guard is best-effort */ }
  }

  const wakeWords = ((await kvGet('camera_wake_words')) ?? DEFAULT_WAKE_WORDS)
    .split(',').map((s) => s.trim()).filter(Boolean)
  const utterance = matchCameraWake(transcript, wakeWords)
  if (utterance === null) {
    // No wake word — heard speech but not addressed to us. Silent + cheap.
    return NextResponse.json({ ok: true, heard: transcript, matched: false })
  }

  // Trivial-utterance filter: noise chunks transcribe to just the wake word,
  // "." or similar — a real request has actual words after the wake phrase.
  // (Costs the rare "staff only called, said nothing" ping; worth it.)
  const letters = utterance.replace(/[^\p{L}\p{N}]/gu, '')
  if (letters.length < 3) {
    return NextResponse.json({ ok: true, heard: transcript, matched: true, forwarded: false, reason: 'trivial' })
  }

  // Cooldown: a burst of chunks around one sentence should ping the owner once.
  const cooldownSec = Number((await kvGet('camera_listen_cooldown_sec')) ?? DEFAULT_COOLDOWN_SEC) || DEFAULT_COOLDOWN_SEC
  const cooldownKey = cameraCooldownKey(room)
  const lastRaw = await kvGet(cooldownKey)
  const now = Date.now()
  if (lastRaw) {
    const last = Date.parse(lastRaw)
    if (Number.isFinite(last) && now - last < cooldownSec * 1000) {
      return NextResponse.json({ ok: true, heard: transcript, matched: true, forwarded: false, reason: 'cooldown' })
    }
  }

  const label = cameraRoomLabel(room)
  const msg = `🎤 ${label} ক্যামেরায় স্টাফ ডাকলো:\n\n«${utterance}»\n\nউত্তর দিলে বলুন — "${room} ক্যামেরায় বলো: …" — আমি স্পিকারে বলে দেবো, Boss।`

  const res = await sendOwnerText(msg)
  if (res.ok) await kvSet(cooldownKey, new Date(now).toISOString())

  return NextResponse.json({ ok: true, heard: transcript, matched: true, forwarded: res.ok, error: res.error })
}

// Authenticated health probe + heartbeat for the durable office-PC listener.
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const auth = await cameraRequestAuthorized(req.headers, 'listener')
  if (!auth.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const room = canonicalCameraRoom(req.nextUrl.searchParams.get('room') ?? undefined)
  const heartbeat = await recordCameraHeartbeat({ component: 'listener', room })
  return NextResponse.json({
    ok: true,
    component: 'listener',
    room,
    credentialSource: auth.credentialSource,
    serverNow: new Date().toISOString(),
    heartbeatRecorded: heartbeat.recorded,
  })
}
