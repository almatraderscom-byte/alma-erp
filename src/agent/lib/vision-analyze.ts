/**
 * Gemini Flash structured vision analysis — shared helper for vision tools.
 * Each caller provides a prompt and gets back parsed JSON.
 */
import { logCost } from '@/agent/lib/cost-events'
import { agentStorageDownload } from '@/agent/lib/storage'

const DEFAULT_VISION_MODEL = 'gemini-2.5-flash'

// Google Gemini API list prices (USD per 1M tokens), used for real cost logging.
// Keep in sync with https://ai.google.dev/pricing. Falls back to Flash rates.
const VISION_PRICES: Record<string, { in: number; out: number }> = {
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
}

interface GeminiVisionOpts {
  prompt: string
  imageBase64: string
  mimeType: string
  costKind: string
  maxTokens?: number
  /** Override the vision model, e.g. 'gemini-2.5-pro' for a high-accuracy confirm pass. */
  model?: string
  /**
   * Extra interleaved text/image parts appended AFTER the main prompt+image —
   * used by CS product matching to show catalog candidate photos alongside the
   * customer photo in one request.
   */
  extraParts?: Array<{ text: string } | { imageBase64: string; mimeType: string }>
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

export async function geminiVisionJson<T>(opts: GeminiVisionOpts): Promise<T> {
  await (await import('@/agent/lib/models/cost-gate')).assertPaidCallAllowed('vision_json')
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const model = opts.model ?? DEFAULT_VISION_MODEL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
  // gemini-2.5-* are thinking models: without a thinking cap, the model can spend
  // its whole output budget on internal reasoning and return TRUNCATED text (an
  // opening `{` with no closing `}`) — which used to fail JSON parsing here.
  // Fixes: (1) responseMimeType json forces a clean JSON-only body, (2) cap the
  // thinking budget so the JSON itself always fits, (3) a larger token budget for
  // headroom. Flash (the cheap per-frame scan) needs no thinking; Pro (the rare
  // confirm pass) keeps a small budget for accuracy.
  const thinkingBudget = model.includes('pro') ? 256 : 0
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: opts.prompt },
          { inline_data: { mime_type: opts.mimeType, data: opts.imageBase64 } },
          ...(opts.extraParts ?? []).map((p) =>
            'text' in p
              ? { text: p.text }
              : { inline_data: { mime_type: p.mimeType, data: p.imageBase64 } },
          ),
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: opts.maxTokens ?? 2048,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini vision HTTP ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = (await res.json()) as GeminiResponse
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    // Surface WHY so a repeat is diagnosable (truncation shows finishReason MAX_TOKENS).
    const finishReason = data.candidates?.[0]?.finishReason ?? 'unknown'
    throw new Error(
      `Gemini returned no parseable JSON (finishReason=${finishReason}, len=${raw.length})`,
    )
  }

  const tokensIn = data.usageMetadata?.promptTokenCount ?? 500
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 200
  const price = VISION_PRICES[model] ?? VISION_PRICES[DEFAULT_VISION_MODEL]!
  const costUsd = (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out
  void logCost({
    provider: 'gemini',
    kind: opts.costKind as 'cs_vision',
    units: { model, tokens_in: tokensIn, tokens_out: tokensOut },
    costUsd,
    dedupKey: `vision:${opts.costKind}:${model}:${opts.imageBase64.slice(0, 24)}`,
  })

  return JSON.parse(jsonMatch[0]) as T
}

/**
 * Resolve a storage path to base64 + mime type.
 * Supports agent-files paths from uploaded files.
 */
export async function resolveImageFromPath(
  filePath: string,
): Promise<{ base64: string; mimeType: string }> {
  const buffer = await agentStorageDownload(filePath)
  const base64 = buffer.toString('base64')

  let mimeType = 'image/jpeg'
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.png')) mimeType = 'image/png'
  else if (lower.endsWith('.webp')) mimeType = 'image/webp'
  else if (lower.endsWith('.gif')) mimeType = 'image/gif'
  else if (lower.endsWith('.pdf')) mimeType = 'application/pdf'

  return { base64, mimeType }
}
