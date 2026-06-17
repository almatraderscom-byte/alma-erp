/**
 * Gemini Flash structured vision analysis — shared helper for vision tools.
 * Each caller provides a prompt and gets back parsed JSON.
 */
import { logCost } from '@/agent/lib/cost-events'
import { agentStorageDownload } from '@/agent/lib/storage'

const VISION_MODEL = 'gemini-2.5-flash'

interface GeminiVisionOpts {
  prompt: string
  imageBase64: string
  mimeType: string
  costKind: string
  maxTokens?: number
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

export async function geminiVisionJson<T>(opts: GeminiVisionOpts): Promise<T> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: opts.prompt },
          { inline_data: { mime_type: opts.mimeType, data: opts.imageBase64 } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: opts.maxTokens ?? 1024 },
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
  if (!jsonMatch) throw new Error('Gemini returned no parseable JSON')

  const tokensIn = data.usageMetadata?.promptTokenCount ?? 500
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 200
  void logCost({
    provider: 'gemini',
    kind: opts.costKind as 'cs_vision',
    units: { model: VISION_MODEL, tokens_in: tokensIn, tokens_out: tokensOut },
    costUsd: 0.0001,
    dedupKey: `vision:${opts.costKind}:${opts.imageBase64.slice(0, 24)}`,
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
