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
import { sarvamVoiceFor } from '@/agent/lib/voice-provider-intent'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const ELEVEN_OUTBOUND_URL = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call'
const DEFAULT_DAILY_CAP = 10
/** The exact one-way voice the owner loves — now on two-way calls via ConversationRelay. */
const RELAY_TTS_VOICE = 'bn-IN-Chirp3-HD-Charon'
/**
 * Speech hints — business/call words the owner actually uses, fed to the STT so
 * Bangla telephony audio stops mis-hearing them (live 2026-07-18: "সেল আছে?" was
 * transcribed "সেল বিচে?"). Comma-separated, owner-tunable via VOICE_RELAY_HINTS.
 */
const RELAY_STT_HINTS =
  'সেল,বিক্রি,অর্ডার,ডেলিভারি,পেমেন্ট,বাকি,টাকা,কাস্টমার,স্টক,দোকান,আজকে,কালকে,কত,দাম,প্রোডাক্ট,ছবি,পোস্ট,মিটিং,রিমাইন্ডার,বস'

/** Which engine runs two-way calls: ElevenLabs ConvAI (legacy), Twilio
 * ConversationRelay + Gemini + Google Charon (relay), or Twilio Media Streams →
 * our Sarvam pipeline (saaras:v3 STT + Gemini + Bulbul TTS, owner's chosen voice). */
export type VoiceCallProvider = 'elevenlabs' | 'relay' | 'sarvam' | 'ngs'

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
  twilioAccountSid: string
  twilioAuthToken: string
  twilioFromNumber: string
  internalToken: string
  /** ngs provider only — infosoftbd (NextGenSwitch) BD number + Gemini Live bot */
  ngsApiBase: string
  ngsApiKey: string
  ngsApiSecret: string
  ngsFrom: string
  ngsLiveWsUrl: string
}

/** Read + validate config from env. `enabled` is false unless everything required is present. */
export function getVoiceCallConfig(): VoiceCallConfig {
  const provider: VoiceCallProvider =
    process.env.VOICE_CALL_PROVIDER === 'ngs' ? 'ngs'
      : process.env.VOICE_CALL_PROVIDER === 'sarvam' ? 'sarvam'
        : process.env.VOICE_CALL_PROVIDER === 'relay' ? 'relay'
          : 'elevenlabs'
  const apiKey = process.env.ELEVENLABS_API_KEY ?? ''
  const agentId = process.env.ELEVENLABS_AGENT_ID ?? ''
  const agentPhoneNumberId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID ?? ''
  const killSwitch = process.env.VOICE_CALL_ENABLED === 'true'
  const dailyCap = Number(process.env.VOICE_CALL_DAILY_CAP) || DEFAULT_DAILY_CAP
  const maxMinutes = Number(process.env.VOICE_CALL_MAX_MINUTES) || 10
  const relayWssUrl = (process.env.VOICE_RELAY_PUBLIC_WSS_URL ?? '').replace(/\/$/, '')
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID ?? ''
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ?? ''
  const twilioFromNumber = process.env.TWILIO_FROM_NUMBER ?? ''
  const internalToken = process.env.AGENT_INTERNAL_TOKEN ?? ''
  // ngs = infosoftbd (NextGenSwitch) BD number; two-way runs on the Gemini Live bot.
  const ngsApiBase = (process.env.NGS_API_BASE ?? 'https://alma-traders.infosoftbd.com').replace(/\/$/, '')
  const ngsApiKey = process.env.NGS_API_KEY ?? ''
  const ngsApiSecret = process.env.NGS_API_SECRET ?? ''
  const ngsFrom = process.env.NGS_FROM ?? '2323'
  const ngsLiveWsUrl = process.env.NGS_LIVE_WS_URL ?? '' // e.g. ws://31.97.237.40:8766/ws
  const enabled =
    killSwitch &&
    (provider === 'ngs'
      ? Boolean(ngsApiKey && ngsApiSecret && ngsLiveWsUrl)
      : provider === 'relay' || provider === 'sarvam'
        ? Boolean(relayWssUrl && twilioAccountSid && twilioAuthToken && twilioFromNumber && internalToken)
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
    twilioAccountSid,
    twilioAuthToken,
    twilioFromNumber,
    internalToken,
    ngsApiBase,
    ngsApiKey,
    ngsApiSecret,
    ngsFrom,
    ngsLiveWsUrl,
  }
}

/** Human-readable reason the feature is unavailable, or null if it is ready. */
export function voiceCallUnavailableReason(config = getVoiceCallConfig()): string | null {
  if (process.env.VOICE_CALL_ENABLED !== 'true') {
    return 'ভয়েস কল বন্ধ আছে (VOICE_CALL_ENABLED off)। চালু করতে owner সেটিং লাগবে।'
  }
  if (config.provider === 'ngs') {
    if (!config.ngsApiKey || !config.ngsApiSecret) return 'NGS_API_KEY / NGS_API_SECRET সেট করা নেই (infosoftbd Programmable Voice API)।'
    if (!config.ngsLiveWsUrl) return 'NGS_LIVE_WS_URL সেট করা নেই — Gemini Live bot-এর ws ঠিকানা বসান (যেমন ws://31.97.237.40:8766/ws)।'
    return null
  }
  if (config.provider === 'relay' || config.provider === 'sarvam') {
    if (!config.relayWssUrl) return 'VOICE_RELAY_PUBLIC_WSS_URL সেট করা নেই — VPS relay-এর পাবলিক wss ঠিকানা বসান।'
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
  /** Sarvam two-way path only: male → ashutosh/bulbul:v3, female → anushka/bulbul:v2.
   * Resolved from Boss's words (voice-provider-intent). Defaults to female. */
  voiceGender?: 'male' | 'female'
  /** Who the agent is talking to, so the Gemini Live bot picks the right persona:
   * 'owner' (companion, the default), 'staff' (calling an ALMA staff member on the
   * owner's behalf), or 'contact' (calling a saved family/friend contact). Only the
   * ngs (Gemini Live) provider uses this today. */
  callType?: 'owner' | 'staff' | 'contact'
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

  if (config.provider === 'ngs') {
    return placeNgsLiveCall(config, record.id, toNumber, purpose, input.recipientName, input.voiceGender, input.callType)
  }

  if (config.provider === 'sarvam') {
    return placeSarvamMediaCall(config, record.id, toNumber, firstMessage, purpose, input.recipientName, input.voiceGender)
  }

  if (config.provider === 'relay') {
    return placeRelayCall(config, record.id, toNumber, firstMessage, purpose, input.recipientName)
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
      // Turn-taking: Twilio defaults reportInputDuringAgentSpeech to "none", so anything
      // the other person said WHILE the agent was talking never reached us — their
      // sentence was simply lost and the agent carried on its own way (owner's "amar
      // kotha na bujhei nijer moto kotha bola"). "speech" delivers those words; the
      // default interruptible="any" already stops the TTS when they start speaking.
      // "any" = speech AND DTMF reported even while the agent is talking. DTMF is the
      // owner's STT-proof hang-up (press any key), so it must never be swallowed.
      ` reportInputDuringAgentSpeech="${process.env.VOICE_RELAY_REPORT_DURING_SPEECH ?? 'any'}"` +
      // Barge-in: default sensitivity is "high", so the owner's own low-volume echo /
      // line noise kept interrupting the agent mid-sentence — his "বাক্য শেষ না করে
      // অন্য বাক্য শুরু করে". "low" needs real, confident, longer speech to cut the TTS;
      // genuine barge-in still works. Owner-tunable via VOICE_RELAY_INTERRUPT_SENSITIVITY.
      ` interruptSensitivity="${process.env.VOICE_RELAY_INTERRUPT_SENSITIVITY ?? 'low'}"` +
      // Bias the STT toward the words the owner actually says on these calls.
      ` hints="${escapeXmlAttr(process.env.VOICE_RELAY_HINTS ?? RELAY_STT_HINTS)}"` +
      (process.env.VOICE_RELAY_SPEECH_TIMEOUT_MS
        ? ` speechTimeout="${process.env.VOICE_RELAY_SPEECH_TIMEOUT_MS}"`
        : '') +
      `>` +
      `<Parameter name="callRecordId" value="${escapeXmlAttr(callRecordId)}"/>` +
      `<Parameter name="purpose" value="${escapeXmlAttr(purpose)}"/>` +
      `<Parameter name="recipientName" value="${escapeXmlAttr(recipientName ?? '')}"/>` +
      `</ConversationRelay></Connect></Response>`

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
        summary: `relay ws: ${base}`,
      },
    })
    return { ok: true, callRecordId, callSid: data.sid }
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
 * Two-way call via Twilio Media Streams → our Sarvam pipeline (worker/src/voice-relay/
 * sarvam-media.mjs on /media): Sarvam saaras:v3 STT + Gemini + Sarvam Bulbul TTS in the
 * owner's chosen voice. This is the voice the owner approved on live telephony samples —
 * far better Bangla than the ConversationRelay (Google/Deepgram) path. Media Streams
 * can't carry the token in the URL, so id/exp/t ride as <Parameter> and are verified on
 * the 'start' frame (see sarvam-media.mjs). Voice = SARVAM_VOICE[voiceGender]:
 * male → ashutosh/bulbul:v3, female → anushka/bulbul:v2 (speaker + model travel together).
 */
async function placeSarvamMediaCall(
  config: VoiceCallConfig,
  callRecordId: string,
  toNumber: string,
  firstMessage: string,
  purpose: string,
  recipientName: string | undefined,
  voiceGender: 'male' | 'female' | undefined,
): Promise<PlaceCallResult> {
  try {
    const exp = Date.now() + 15 * 60_000
    const t = createHmac('sha256', config.internalToken)
      .update(`relay:${callRecordId}:${exp}`)
      .digest('hex')
    // relayWssUrl may end in /relay, /media, or nothing — normalise then append /media.
    const base = config.relayWssUrl.replace(/\/(relay|media)$/, '')
    const wssUrl = `${base}/media`
    const voice = sarvamVoiceFor(voiceGender)

    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Connect>` +
      `<Stream url="${escapeXmlAttr(wssUrl)}">` +
      `<Parameter name="id" value="${escapeXmlAttr(callRecordId)}"/>` +
      `<Parameter name="exp" value="${exp}"/>` +
      `<Parameter name="t" value="${t}"/>` +
      `<Parameter name="firstMessage" value="${escapeXmlAttr(firstMessage)}"/>` +
      `<Parameter name="purpose" value="${escapeXmlAttr(purpose)}"/>` +
      `<Parameter name="recipientName" value="${escapeXmlAttr(recipientName ?? '')}"/>` +
      `<Parameter name="speaker" value="${escapeXmlAttr(voice.speaker)}"/>` +
      `<Parameter name="ttsModel" value="${escapeXmlAttr(voice.model)}"/>` +
      `</Stream></Connect></Response>`

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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
        body,
        signal: AbortSignal.timeout(30_000),
      },
    )
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string }
    if (!res.ok || !data.sid) {
      const err = `Twilio ${res.status}: ${data.message ?? 'call create failed'}`
      await db.agentVoiceCall.update({ where: { id: callRecordId }, data: { status: 'failed', summary: err } })
      return { ok: false, error: err, callRecordId }
    }
    await db.agentVoiceCall.update({
      where: { id: callRecordId },
      data: { status: 'ringing', callSid: data.sid, summary: `sarvam media: ${voice.speaker}/${voice.model}` },
    })
    return { ok: true, callRecordId, callSid: data.sid }
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
 * Two-way call via infosoftbd (NextGenSwitch) BD number → our Gemini Live bot
 * (worker/scripts/gemini-live-bot.mjs): gemini-3.1-flash-live realtime speech-to-speech,
 * native barge-in, empathetic Bangla, DELETE-based hang-up. Owner-locked 2026-07-18 as
 * the two-way engine (male=Charon, female=Aoede). Places the call via the NGS
 * Programmable Voice API and points <Connect><Stream> at the bot's ws URL.
 */
async function placeNgsLiveCall(
  config: VoiceCallConfig,
  callRecordId: string,
  toNumber: string,
  purpose: string,
  recipientName: string | undefined,
  voiceGender: 'male' | 'female' | undefined,
  callType: 'owner' | 'staff' | 'contact' | undefined,
): Promise<PlaceCallResult> {
  try {
    const exp = Date.now() + 15 * 60_000
    const t = createHmac('sha256', config.internalToken).update(`relay:${callRecordId}:${exp}`).digest('hex')
    const voice = voiceGender === 'female' ? 'Aoede' : 'Charon'
    const P = (n: string, v: string) => `<parameter name="${escapeXmlAttr(n)}" value="${escapeXmlAttr(v)}"/>`
    const responseXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<response><connect><stream name="alma" url="${escapeXmlAttr(config.ngsLiveWsUrl)}">` +
      P('id', callRecordId) + P('exp', String(exp)) + P('t', t) +
      P('purpose', purpose) + P('recipientName', recipientName ?? '') + P('voice', voice) +
      P('callType', callType ?? 'owner') +
      '</stream></connect></response>'

    // NGS outbound routes match 01…/880… WITHOUT a leading '+' (normalizeOutboundPhone
    // returns +E.164 for Twilio); sending '+880…' → NGS "No route found" (code 3).
    const ngsTo = toNumber.replace(/^\+/, '')
    const body = new URLSearchParams({ to: ngsTo, from: config.ngsFrom, responseXml })
    const res = await fetch(`${config.ngsApiBase}/api/v1/call`, {
      method: 'POST',
      headers: {
        'X-Authorization': config.ngsApiKey,
        'X-Authorization-Secret': config.ngsApiSecret,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await res.json().catch(() => ({}))) as { call_id?: string; status?: string }
    if (!res.ok || !data.call_id) {
      const err = `NGS ${res.status}: ${JSON.stringify(data).slice(0, 160)}`
      await db.agentVoiceCall.update({ where: { id: callRecordId }, data: { status: 'failed', summary: err } })
      return { ok: false, error: err, callRecordId }
    }
    await db.agentVoiceCall.update({
      where: { id: callRecordId },
      data: { status: 'ringing', callSid: data.call_id, summary: `ngs live: ${voice}` },
    })
    return { ok: true, callRecordId, callSid: data.call_id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.agentVoiceCall.update({
      where: { id: callRecordId },
      data: { status: 'failed', summary: `কল দেওয়া যায়নি: ${msg}` },
    }).catch(() => {})
    return { ok: false, error: `কল দেওয়া যায়নি: ${msg}`, callRecordId }
  }
}
