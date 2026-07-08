/**
 * Agent outbound phone calls — ElevenLabs Conversational AI (two-way Bangla) over
 * the owner's own Twilio number. ElevenLabs orchestrates the whole call: it dials
 * out via Twilio, runs full-duplex STT → LLM → TTS in the owner's Bangla voice, and
 * after the call ends POSTs a signed transcript + summary to our webhook.
 *
 * This module is the single place that:
 *   - reads & validates config (kill-switch, agent id, phone-number id, caps),
 *   - enforces the daily call cap BEFORE any paid work,
 *   - places the call and records an `agent_voice_calls` row.
 *
 * Cost note: ElevenLabs conversational minutes are expensive, so this is gated hard
 * (VOICE_CALL_ENABLED off by default) and the owner approves every call via a
 * pending-action card before it actually dials. Used sparingly — family / friends /
 * work, never bulk.
 */
import { createHmac } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { normalizeOutboundPhone } from '@/lib/twilio/phone'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const ELEVEN_OUTBOUND_URL = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call'
const DEFAULT_DAILY_CAP = 10
/** The exact one-way voice the owner loves — now on two-way calls via ConversationRelay. */
const RELAY_TTS_VOICE = 'bn-IN-Chirp3-HD-Charon'

/** Which engine runs two-way calls: ElevenLabs ConvAI (legacy), Twilio
 * ConversationRelay + Gemini + Google Charon voice, or the Cartesia bridge
 * (Twilio Media Streams + OpenAI STT + Gemini + Cartesia Sonic Bangla voice —
 * owner verdict 2026-07: Google's bn TTS is "not as human", Cartesia is). */
export type VoiceCallProvider = 'elevenlabs' | 'relay' | 'cartesia'

export interface VoiceCallConfig {
  enabled: boolean
  provider: VoiceCallProvider
  apiKey: string
  agentId: string
  agentPhoneNumberId: string
  dailyCap: number
  maxMinutes: number
  /** relay provider only */
  relayWssUrl: string
  /** cartesia provider only — public wss URL of worker/src/voice-relay/cartesia-bridge.mjs */
  bridgeWssUrl: string
  twilioAccountSid: string
  twilioAuthToken: string
  twilioFromNumber: string
  internalToken: string
}

/** Read + validate config from env. `enabled` is false unless everything required is present. */
export function getVoiceCallConfig(): VoiceCallConfig {
  const provider: VoiceCallProvider =
    process.env.VOICE_CALL_PROVIDER === 'relay'
      ? 'relay'
      : process.env.VOICE_CALL_PROVIDER === 'cartesia'
        ? 'cartesia'
        : 'elevenlabs'
  const apiKey = process.env.ELEVENLABS_API_KEY ?? ''
  const agentId = process.env.ELEVENLABS_AGENT_ID ?? ''
  const agentPhoneNumberId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID ?? ''
  const killSwitch = process.env.VOICE_CALL_ENABLED === 'true'
  const dailyCap = Number(process.env.VOICE_CALL_DAILY_CAP) || DEFAULT_DAILY_CAP
  const maxMinutes = Number(process.env.VOICE_CALL_MAX_MINUTES) || 10
  const relayWssUrl = (process.env.VOICE_RELAY_PUBLIC_WSS_URL ?? '').replace(/\/$/, '')
  const bridgeWssUrl = (process.env.VOICE_BRIDGE_PUBLIC_WSS_URL ?? '').replace(/\/$/, '')
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID ?? ''
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ?? ''
  const twilioFromNumber = process.env.TWILIO_FROM_NUMBER ?? ''
  const internalToken = process.env.AGENT_INTERNAL_TOKEN ?? ''
  const twilioReady = Boolean(twilioAccountSid && twilioAuthToken && twilioFromNumber && internalToken)
  const enabled =
    killSwitch &&
    (provider === 'relay'
      ? Boolean(relayWssUrl) && twilioReady
      : provider === 'cartesia'
        ? Boolean(bridgeWssUrl) && twilioReady
        : Boolean(apiKey && agentId && agentPhoneNumberId))
  return {
    enabled,
    provider,
    apiKey,
    agentId,
    agentPhoneNumberId,
    dailyCap,
    maxMinutes,
    relayWssUrl,
    bridgeWssUrl,
    twilioAccountSid,
    twilioAuthToken,
    twilioFromNumber,
    internalToken,
  }
}

/** Human-readable reason the feature is unavailable, or null if it is ready. */
export function voiceCallUnavailableReason(config = getVoiceCallConfig()): string | null {
  if (process.env.VOICE_CALL_ENABLED !== 'true') {
    return 'ভয়েস কল বন্ধ আছে (VOICE_CALL_ENABLED off)। চালু করতে owner সেটিং লাগবে।'
  }
  if (config.provider === 'relay' || config.provider === 'cartesia') {
    if (config.provider === 'relay' && !config.relayWssUrl) {
      return 'VOICE_RELAY_PUBLIC_WSS_URL সেট করা নেই — VPS relay-এর পাবলিক wss ঠিকানা বসান।'
    }
    if (config.provider === 'cartesia' && !config.bridgeWssUrl) {
      return 'VOICE_BRIDGE_PUBLIC_WSS_URL সেট করা নেই — VPS Cartesia bridge-এর পাবলিক wss ঠিকানা বসান।'
    }
    if (!config.twilioAccountSid || !config.twilioAuthToken) return 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN সেট করা নেই।'
    if (!config.twilioFromNumber) return 'TWILIO_FROM_NUMBER সেট করা নেই।'
    if (!config.internalToken) return 'AGENT_INTERNAL_TOKEN সেট করা নেই।'
    return null
  }
  if (!config.apiKey) return 'ELEVENLABS_API_KEY সেট করা নেই।'
  if (!config.agentId) return 'ELEVENLABS_AGENT_ID সেট করা নেই — ElevenLabs ড্যাশবোর্ডে Agent বানিয়ে আইডি বসান।'
  if (!config.agentPhoneNumberId) {
    return 'ELEVENLABS_AGENT_PHONE_NUMBER_ID সেট করা নেই — Twilio নম্বর import করে phone_number_id বসান।'
  }
  return null
}

/** Dhaka-day start as a Date (for the daily-cap window). */
function dhakaDayStart(now = new Date()): Date {
  // Dhaka is UTC+6, no DST. Shift to Dhaka, floor to midnight, shift back.
  const dhaka = new Date(now.getTime() + 6 * 60 * 60 * 1000)
  dhaka.setUTCHours(0, 0, 0, 0)
  return new Date(dhaka.getTime() - 6 * 60 * 60 * 1000)
}

/** How many agent calls have been placed today (Dhaka), for cap enforcement. */
export async function callsPlacedToday(): Promise<number> {
  return db.agentVoiceCall.count({
    where: { createdAt: { gte: dhakaDayStart() } },
  })
}

export interface PlaceCallInput {
  toNumber: string
  recipientName?: string
  /** Why we are calling — owner intent, in Bangla. Steers the agent's prompt. */
  purpose: string
  /** First line the agent speaks when the person picks up (Bangla). */
  firstMessage: string
  conversationId?: string | null
}

export interface PlaceCallResult {
  ok: boolean
  callRecordId?: string
  elevenConvId?: string
  callSid?: string
  error?: string
}

/**
 * Place the call. Enforces kill-switch + daily cap, normalises the number, calls
 * ElevenLabs, and writes an `agent_voice_calls` row (status 'initiated'). The
 * transcript + summary arrive later via the post-call webhook.
 */
export async function placeOutboundCall(input: PlaceCallInput): Promise<PlaceCallResult> {
  const config = getVoiceCallConfig()
  const unavailable = voiceCallUnavailableReason(config)
  if (unavailable) return { ok: false, error: unavailable }

  const toNumber = normalizeOutboundPhone(input.toNumber)
  if (!toNumber) return { ok: false, error: 'নম্বরটি ঠিক নয় — 01XXXXXXXXX বা +880… ফরম্যাটে দিন।' }

  const placedToday = await callsPlacedToday()
  if (placedToday >= config.dailyCap) {
    return { ok: false, error: `আজকের কল লিমিট শেষ (${config.dailyCap}টি)। কাল আবার চেষ্টা করুন।` }
  }

  const firstMessage = input.firstMessage.trim() || 'আসসালামু আলাইকুম।'
  const purpose = input.purpose.trim()

  // Pre-record the row so a webhook that races the response still has a target.
  const record = await db.agentVoiceCall.create({
    data: {
      toNumber,
      recipientName: input.recipientName ?? null,
      purpose: purpose || null,
      firstMessage,
      status: 'initiated',
      conversationId: input.conversationId ?? null,
    },
  })

  if (config.provider === 'relay') {
    return placeRelayCall(config, record.id, toNumber, firstMessage, purpose, input.recipientName)
  }
  if (config.provider === 'cartesia') {
    return placeCartesiaCall(config, record.id, toNumber, firstMessage, purpose, input.recipientName)
  }

  try {
    const res = await fetch(ELEVEN_OUTBOUND_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: config.agentId,
        agent_phone_number_id: config.agentPhoneNumberId,
        to_number: toNumber,
        conversation_initiation_client_data: {
          conversation_config_override: {
            agent: {
              first_message: firstMessage,
              // NOTE: do NOT send `language` here. ElevenLabs has no Bengali (`bn`)
              // agent language, and the language override is intentionally disabled
              // agent-side. Sending an unsupported/disabled field makes ElevenLabs
              // reject the whole conversation init → the call connects then drops
              // silently after ~2s. The agent's base config (flash_v2_5 multilingual
              // TTS + Bangla prompt) already speaks Bangla; we only override the
              // per-call first_message and prompt (both enabled).
              ...(purpose
                ? {
                    prompt: {
                      prompt:
                        `তুমি ${input.recipientName ? input.recipientName + ' কে' : 'একজনকে'} ` +
                        `মালিকের পক্ষ থেকে ফোন করছ। উদ্দেশ্য: ${purpose}। ` +
                        `বিনয়ী, পরিষ্কার বাংলায় কথা বলো; অন্য পক্ষের কথা মন দিয়ে শোনো এবং ` +
                        `প্রয়োজনীয় তথ্য আদায় করো। কাজ শেষ হলে ভদ্রভাবে কল শেষ করো।`,
                    },
                  }
                : {}),
            },
          },
          dynamic_variables: {
            recipient_name: input.recipientName ?? '',
            call_purpose: purpose,
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    })

    const text = await res.text()
    let data: { success?: boolean; conversation_id?: string; callSid?: string; message?: string } = {}
    try {
      data = JSON.parse(text)
    } catch {
      /* non-JSON error body */
    }

    if (!res.ok || data.success === false) {
      const err = data.message || `ElevenLabs HTTP ${res.status}: ${text.slice(0, 160)}`
      await db.agentVoiceCall.update({
        where: { id: record.id },
        data: { status: 'failed', summary: err },
      })
      return { ok: false, error: err, callRecordId: record.id }
    }

    await db.agentVoiceCall.update({
      where: { id: record.id },
      data: {
        status: 'ringing',
        elevenConvId: data.conversation_id ?? null,
        callSid: data.callSid ?? null,
      },
    })

    return {
      ok: true,
      callRecordId: record.id,
      elevenConvId: data.conversation_id,
      callSid: data.callSid,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.agentVoiceCall.update({
      where: { id: record.id },
      data: { status: 'failed', summary: `কল দেওয়া যায়নি: ${msg}` },
    }).catch(() => {})
    return { ok: false, error: `কল দেওয়া যায়নি: ${msg}`, callRecordId: record.id }
  }
}

function escapeXmlAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Two-way call via Twilio ConversationRelay: Twilio streams STT + speaks Gemini's
 * replies in Google's bn-IN-Chirp3-HD-Charon voice (the same voice as one-way
 * calls — far better Bangla than ElevenLabs realtime). The conversation brain is
 * the VPS relay server (worker/src/voice-relay/server.mjs); the wss URL is signed
 * with AGENT_INTERNAL_TOKEN so only our calls can connect. Transcript + summary
 * come back via /api/assistant/voice-call/relay-report when the call ends.
 */
async function placeRelayCall(
  config: VoiceCallConfig,
  callRecordId: string,
  toNumber: string,
  firstMessage: string,
  purpose: string,
  recipientName?: string,
): Promise<PlaceCallResult> {
  try {
    // Signature scheme mirrors worker/src/voice-relay/server.mjs signRelayToken().
    const exp = Date.now() + 15 * 60_000
    const t = createHmac('sha256', config.internalToken)
      .update(`relay:${callRecordId}:${exp}`)
      .digest('hex')
    const base = config.relayWssUrl.endsWith('/relay') ? config.relayWssUrl : `${config.relayWssUrl}/relay`
    const wssUrl = `${base}?id=${encodeURIComponent(callRecordId)}&exp=${exp}&t=${t}`

    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Connect>` +
      `<ConversationRelay url="${escapeXmlAttr(wssUrl)}"` +
      ` welcomeGreeting="${escapeXmlAttr(firstMessage)}"` +
      // TTS: Twilio validates (provider, ttsLanguage, voice) as a triple — omitting
      // ttsLanguage defaults it to en-US, which rejects the bn-IN voice (64101,
      // live-verified). Twilio's voice list documents bn-IN + bn-IN-Chirp3-HD-Charon.
      // STT: Deepgram nova-3 (Bengali `bn` is in its language list) — live call #9
      // proved Google bn-BD/long near-deaf on telephony audio (2 words heard in
      // 89s), and the forced 1.2s speechTimeout made it worse (now default-auto
      // by omission). Deepgram's realtime endpointing is also much faster. All
      // env-tunable; the Google path stays reachable via VOICE_RELAY_STT_*.
      ` ttsProvider="Google" voice="${RELAY_TTS_VOICE}"` +
      ` ttsLanguage="${process.env.VOICE_RELAY_TTS_LANGUAGE ?? 'bn-IN'}"` +
      ` transcriptionProvider="${process.env.VOICE_RELAY_STT_PROVIDER ?? 'Deepgram'}"` +
      ` transcriptionLanguage="${process.env.VOICE_RELAY_STT_LANGUAGE ?? 'bn'}"` +
      ` speechModel="${process.env.VOICE_RELAY_STT_MODEL ?? 'nova-3-general'}"` +
      (process.env.VOICE_RELAY_SPEECH_TIMEOUT_MS
        ? ` speechTimeout="${process.env.VOICE_RELAY_SPEECH_TIMEOUT_MS}"`
        : '') +
      `>` +
      `<Parameter name="callRecordId" value="${escapeXmlAttr(callRecordId)}"/>` +
      `<Parameter name="purpose" value="${escapeXmlAttr(purpose)}"/>` +
      `<Parameter name="recipientName" value="${escapeXmlAttr(recipientName ?? '')}"/>` +
      `</ConversationRelay></Connect></Response>`

    return dialWithTwiml(config, callRecordId, toNumber, twiml, `relay ws: ${base}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.agentVoiceCall.update({
      where: { id: callRecordId },
      data: { status: 'failed', summary: `কল দেওয়া যায়নি: ${msg}` },
    }).catch(() => {})
    return { ok: false, error: `কল দেওয়া যায়নি: ${msg}`, callRecordId }
  }
}

/**
 * Two-way call via the Cartesia bridge: Twilio Media Streams pipes raw call audio
 * to the VPS bridge (worker/src/voice-relay/cartesia-bridge.mjs), which runs
 * OpenAI streaming STT (bn) → Gemini → Cartesia Sonic TTS (natural Bangla voice).
 * Same HMAC-signed URL and relay-report flow as the ConversationRelay provider.
 */
async function placeCartesiaCall(
  config: VoiceCallConfig,
  callRecordId: string,
  toNumber: string,
  firstMessage: string,
  purpose: string,
  recipientName?: string,
): Promise<PlaceCallResult> {
  try {
    // Signature scheme mirrors worker/src/voice-relay/server.mjs signRelayToken().
    const exp = Date.now() + 15 * 60_000
    const t = createHmac('sha256', config.internalToken)
      .update(`relay:${callRecordId}:${exp}`)
      .digest('hex')
    const base = config.bridgeWssUrl.endsWith('/media') ? config.bridgeWssUrl : `${config.bridgeWssUrl}/media`
    const wssUrl = `${base}?id=${encodeURIComponent(callRecordId)}&exp=${exp}&t=${t}`

    // <Connect><Stream> = bidirectional media stream; the bridge owns STT/LLM/TTS
    // and speaks the greeting itself (no welcomeGreeting attribute here).
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Connect>` +
      `<Stream url="${escapeXmlAttr(wssUrl)}">` +
      `<Parameter name="callRecordId" value="${escapeXmlAttr(callRecordId)}"/>` +
      `<Parameter name="purpose" value="${escapeXmlAttr(purpose.slice(0, 400))}"/>` +
      `<Parameter name="recipientName" value="${escapeXmlAttr(recipientName ?? '')}"/>` +
      `<Parameter name="firstMessage" value="${escapeXmlAttr(firstMessage.slice(0, 400))}"/>` +
      `</Stream></Connect></Response>`

    return dialWithTwiml(config, callRecordId, toNumber, twiml, `bridge ws: ${base}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.agentVoiceCall.update({
      where: { id: callRecordId },
      data: { status: 'failed', summary: `কল দেওয়া যায়নি: ${msg}` },
    }).catch(() => {})
    return { ok: false, error: `কল দেওয়া যায়নি: ${msg}`, callRecordId }
  }
}

/** POST the TwiML to Twilio's Calls API and record ringing/failure on the row. */
async function dialWithTwiml(
  config: VoiceCallConfig,
  callRecordId: string,
  toNumber: string,
  twiml: string,
  wsNote: string,
): Promise<PlaceCallResult> {
  const body = new URLSearchParams({
    To: toNumber,
    From: config.twilioFromNumber,
    Twiml: twiml,
    Timeout: '45',
  })
  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64')
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Calls.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    },
  )
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string }
  if (!res.ok || !data.sid) {
    const err = `Twilio ${res.status}: ${data.message ?? 'call create failed'}`
    await db.agentVoiceCall.update({
      where: { id: callRecordId },
      data: { status: 'failed', summary: err },
    })
    return { ok: false, error: err, callRecordId }
  }

  await db.agentVoiceCall.update({
    where: { id: callRecordId },
    data: {
      status: 'ringing',
      callSid: data.sid,
      // Diagnostic breadcrumb (token redacted): the exact ws endpoint Twilio was
      // told to dial — readable from the DB when a 64102 needs root-causing.
      summary: wsNote,
    },
  })
  return { ok: true, callRecordId, callSid: data.sid }
}
