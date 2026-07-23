/**
 * Gemini Flash vision — product image description for CS-1 indexing + matching.
 */
import { logCost } from '@/agent/lib/cost-events'

const VISION_MODEL = 'gemini-2.5-flash'
const PROMPT = `Describe this clothing/product image for a Bangladesh fashion shop catalog.
Return JSON only:
{
  "description_bn": "rich Bangla visual description (2-4 sentences)",
  "description_en": "English visual description",
  "tags": {
    "category": "e.g. panjabi, frock, family_set",
    "colors": ["..."],
    "pattern": "solid|print|embroidery|...",
    "fabric_look": "cotton|silk|...",
    "family_set": true|false,
    "gender_age": "men|women|boys|girls|baby|unisex"
  }
}`

export type VisionTags = {
  category?: string
  colors?: string[]
  pattern?: string
  fabric_look?: string
  family_set?: boolean
  gender_age?: string
}

export type VisionResult = {
  descriptionBn: string
  descriptionEn: string
  tags: VisionTags
  combinedText: string
}

export async function describeProductImage(imageBase64: string, mimeType: string): Promise<VisionResult> {
  await (await import('@/agent/lib/models/cost-gate')).assertPaidCallAllowed('cs_vision', 'cs')
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
        ],
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini vision HTTP ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
    description_bn?: string
    description_en?: string
    tags?: VisionTags
  }

  const descriptionBn = String(parsed.description_bn ?? '').trim()
  const descriptionEn = String(parsed.description_en ?? '').trim()
  const tags = parsed.tags ?? {}
  const combinedText = [descriptionBn, descriptionEn, JSON.stringify(tags)].filter(Boolean).join('\n')

  const tokensIn = data.usageMetadata?.promptTokenCount ?? 500
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 200
  void logCost({
    provider: 'gemini',
    kind: 'cs_vision',
    units: { model: VISION_MODEL, tokens_in: tokensIn, tokens_out: tokensOut },
    costUsd: 0.0001,
    dedupKey: `cs_vision:${imageBase64.slice(0, 32)}`,
  })

  return { descriptionBn, descriptionEn, tags, combinedText }
}
