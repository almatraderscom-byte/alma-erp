import { isSupportedLiveVoiceModel, isSupportedLiveVoiceName } from '@/agent/lib/live-voice-config'
import { liveVoiceModelContract } from '@/agent/lib/live-voice-contract'

export type LiveVoiceProviderUsage = {
  inputAudioTokens: number
  outputAudioTokens: number
  inputTextTokens: number
  outputTextTokens: number
  inputTotalTokens: number
  outputTotalTokens: number
}

export type LiveVoiceUsageSegment = {
  model: string
  voice: string
  inputAudioQueuedBytes: number
  outputAudioReceivedBytes: number
  inputTranscriptionCharacters: number
  outputTranscriptionCharacters: number
  providerUsage: LiveVoiceProviderUsage
}

export type LiveVoiceUsageReport = {
  callId: string
  conversationId: string | null
  segments: LiveVoiceUsageSegment[]
}

export type PricedLiveVoiceSegment = {
  costUsd: number
  units: Record<string, number | string>
  unresolvedTranscription: boolean
}

const MAX_CALL_SECONDS = 12 * 60 * 60
const MAX_INPUT_BYTES = 16_000 * 2 * MAX_CALL_SECONDS
const MAX_OUTPUT_BYTES = 24_000 * 2 * MAX_CALL_SECONDS
const MAX_TRANSCRIPTION_CHARACTERS = 10_000_000
const MAX_TOKENS = 250_000_000
const AUDIO_TOKENS_PER_SECOND = 25

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function integer(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : null
}

function parseProviderUsage(value: unknown): LiveVoiceProviderUsage | null {
  const row = record(value)
  if (!row) return null
  const inputAudioTokens = integer(row.inputAudioTokens, MAX_TOKENS)
  const outputAudioTokens = integer(row.outputAudioTokens, MAX_TOKENS)
  const inputTextTokens = integer(row.inputTextTokens, MAX_TOKENS)
  const outputTextTokens = integer(row.outputTextTokens, MAX_TOKENS)
  const inputTotalTokens = integer(row.inputTotalTokens, MAX_TOKENS)
  const outputTotalTokens = integer(row.outputTotalTokens, MAX_TOKENS)
  if ([
    inputAudioTokens,
    outputAudioTokens,
    inputTextTokens,
    outputTextTokens,
    inputTotalTokens,
    outputTotalTokens,
  ].some((entry) => entry === null)) return null
  return {
    inputAudioTokens: inputAudioTokens!,
    outputAudioTokens: outputAudioTokens!,
    inputTextTokens: inputTextTokens!,
    outputTextTokens: outputTextTokens!,
    inputTotalTokens: inputTotalTokens!,
    outputTotalTokens: outputTotalTokens!,
  }
}

export function parseLiveVoiceUsageReport(
  value: unknown,
): { ok: true; report: LiveVoiceUsageReport } | { ok: false; error: string } {
  const body = record(value)
  if (!body) return { ok: false, error: 'body_invalid' }
  const callId = typeof body.callId === 'string' ? body.callId.trim().toLowerCase() : ''
  if (!/^[a-z0-9][a-z0-9_-]{7,127}$/.test(callId)) {
    return { ok: false, error: 'call_id_invalid' }
  }
  const conversationId = body.conversationId == null
    ? null
    : typeof body.conversationId === 'string' && body.conversationId.length <= 160
      ? body.conversationId
      : undefined
  if (conversationId === undefined) return { ok: false, error: 'conversation_id_invalid' }
  if (!Array.isArray(body.segments) || body.segments.length < 1 || body.segments.length > 16) {
    return { ok: false, error: 'segments_invalid' }
  }

  const segments: LiveVoiceUsageSegment[] = []
  for (const value of body.segments) {
    const segment = record(value)
    if (!segment) return { ok: false, error: 'segment_invalid' }
    const model = typeof segment.model === 'string' ? segment.model : ''
    const voice = typeof segment.voice === 'string' ? segment.voice : ''
    if (!isSupportedLiveVoiceModel(model)) return { ok: false, error: 'model_invalid' }
    if (!isSupportedLiveVoiceName(voice)) return { ok: false, error: 'voice_invalid' }
    const inputAudioQueuedBytes = integer(segment.inputAudioQueuedBytes, MAX_INPUT_BYTES)
    const outputAudioReceivedBytes = integer(segment.outputAudioReceivedBytes, MAX_OUTPUT_BYTES)
    const inputTranscriptionCharacters = integer(
      segment.inputTranscriptionCharacters,
      MAX_TRANSCRIPTION_CHARACTERS,
    )
    const outputTranscriptionCharacters = integer(
      segment.outputTranscriptionCharacters,
      MAX_TRANSCRIPTION_CHARACTERS,
    )
    const providerUsage = parseProviderUsage(segment.providerUsage)
    if ([
      inputAudioQueuedBytes,
      outputAudioReceivedBytes,
      inputTranscriptionCharacters,
      outputTranscriptionCharacters,
    ].some((entry) => entry === null) || !providerUsage) {
      return { ok: false, error: 'segment_units_invalid' }
    }
    segments.push({
      model,
      voice,
      inputAudioQueuedBytes: inputAudioQueuedBytes!,
      outputAudioReceivedBytes: outputAudioReceivedBytes!,
      inputTranscriptionCharacters: inputTranscriptionCharacters!,
      outputTranscriptionCharacters: outputTranscriptionCharacters!,
      providerUsage,
    })
  }
  return { ok: true, report: { callId, conversationId, segments } }
}

export function priceLiveVoiceUsageSegment(segment: LiveVoiceUsageSegment): PricedLiveVoiceSegment {
  const modelRates = liveVoiceModelContract(segment.model)!.pricingUSDPerMillionTokens
  const inputSeconds = segment.inputAudioQueuedBytes / (16_000 * 2)
  const outputSeconds = segment.outputAudioReceivedBytes / (24_000 * 2)
  const inputAudioTokens = segment.providerUsage.inputAudioTokens > 0
    ? segment.providerUsage.inputAudioTokens
    : inputSeconds * AUDIO_TOKENS_PER_SECOND
  const outputAudioTokens = segment.providerUsage.outputAudioTokens > 0
    ? segment.providerUsage.outputAudioTokens
    : outputSeconds * AUDIO_TOKENS_PER_SECOND
  const inputAudioSource = segment.providerUsage.inputAudioTokens > 0
    ? 'provider_usage_metadata'
    : 'local_queued_pcm_25_tokens_per_second'
  const outputAudioSource = segment.providerUsage.outputAudioTokens > 0
    ? 'provider_usage_metadata'
    : 'local_received_pcm_25_tokens_per_second'
  const inputTextCost = segment.providerUsage.inputTextTokens * modelRates.inputText / 1_000_000
  const outputTextCost = segment.providerUsage.outputTextTokens * modelRates.outputText / 1_000_000
  const inputAudioCost = inputAudioTokens * modelRates.inputAudio / 1_000_000
  const outputAudioCost = outputAudioTokens * modelRates.outputAudio / 1_000_000
  const unresolvedTranscription =
    (segment.inputTranscriptionCharacters + segment.outputTranscriptionCharacters > 0)
    && segment.providerUsage.inputTextTokens + segment.providerUsage.outputTextTokens === 0

  return {
    costUsd: inputTextCost + outputTextCost + inputAudioCost + outputAudioCost,
    unresolvedTranscription,
    units: {
      pricing_version: 'gemini-live-2026-08-11',
      model: segment.model,
      voice: segment.voice,
      input_audio_tokens: inputAudioTokens,
      input_audio_source: inputAudioSource,
      output_audio_tokens: outputAudioTokens,
      output_audio_source: outputAudioSource,
      input_audio_queued_seconds: inputSeconds,
      output_audio_received_seconds: outputSeconds,
      input_text_tokens: segment.providerUsage.inputTextTokens,
      output_text_tokens: segment.providerUsage.outputTextTokens,
      provider_input_total_tokens: segment.providerUsage.inputTotalTokens,
      provider_output_total_tokens: segment.providerUsage.outputTotalTokens,
      input_transcription_characters: segment.inputTranscriptionCharacters,
      output_transcription_characters: segment.outputTranscriptionCharacters,
      transcription_token_source: unresolvedTranscription
        ? 'unresolved_no_provider_modality_tokens'
        : 'provider_usage_metadata',
    },
  }
}

export function liveVoiceUsageDedupKey(
  ownerId: string,
  callId: string,
  segmentIndex: number,
): string {
  return `live-voice:${ownerId}:${callId}:${segmentIndex}`
}
