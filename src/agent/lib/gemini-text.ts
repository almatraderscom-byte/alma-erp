/**
 * Gemini Flash one-shot text generation — shared helper for non-vision text tasks.
 *
 * Used for cheap, Bangla-quality generation that does NOT need Claude (e.g. staff
 * task explanations / work-tracking summaries). Mirrors `geminiVisionJson` in
 * vision-analyze.ts: direct REST to the Generative Language API, GEMINI_API_KEY,
 * cost logged via logCost. Keeps the same "current Gemini model" the agent already
 * uses for staff verification vision (gemini-2.5-flash).
 */
import { logCost } from '@/agent/lib/cost-events'

const GEMINI_TEXT_MODEL = 'gemini-2.5-flash'

interface GeminiTextOpts {
  prompt: string
  /** Short label for cost attribution (stored in units.purpose). */
  costLabel: string
  maxTokens?: number
  temperature?: number
  conversationId?: string | null
}

interface GeminiTextResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

export async function geminiGenerateText(opts: GeminiTextOpts): Promise<string> {
  await (await import('@/agent/lib/models/cost-gate')).assertPaidCallAllowed('gemini_text')
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: opts.prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 512,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini text HTTP ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = (await res.json()) as GeminiTextResponse
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()

  if (!text) throw new Error('Gemini returned empty text')

  const tokensIn = data.usageMetadata?.promptTokenCount ?? 400
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 150
  void logCost({
    provider: 'gemini',
    kind: 'chat',
    units: { model: GEMINI_TEXT_MODEL, tokens_in: tokensIn, tokens_out: tokensOut, purpose: opts.costLabel },
    // Gemini 2.5 Flash is ~$0.30/M in, $2.50/M out — tiny per call; log a small flat estimate.
    costUsd: 0.0002,
    conversationId: opts.conversationId ?? null,
    dedupKey: null,
  })

  return text
}
