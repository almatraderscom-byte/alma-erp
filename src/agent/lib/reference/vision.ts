/**
 * Vision + why-it-works for reference library entries.
 */
import { describeCreativeTaste, type TasteAttrs } from '@/agent/lib/taste/vision'

export type ReferenceAttrs = TasteAttrs & Record<string, unknown>

const WHY_PROMPT = `You analyze fashion ad creatives for a Bangladesh e-commerce brand.
Given the image attributes and optional ad copy, return JSON only:
{"why_it_works":"one concise line — structural pattern only (composition/lighting/mood), NOT brand copy to clone"}
Do NOT suggest copying competitor branding — only the proven visual structure.`

export async function describeReferenceCreative(
  imageBase64: string,
  mimeType: string,
  adCopy?: string | null,
): Promise<{ attrs: ReferenceAttrs; whyItWorks: string }> {
  const attrs = await describeCreativeTaste(imageBase64, mimeType) as ReferenceAttrs
  if (adCopy?.trim()) attrs.ad_copy_sample = adCopy.trim().slice(0, 200)

  const key = process.env.GEMINI_API_KEY
  if (!key) {
    return {
      attrs,
      whyItWorks: inferWhyFromAttrs(attrs),
    }
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `${WHY_PROMPT}\nAttrs: ${JSON.stringify(attrs)}\nAd copy: ${adCopy ?? 'n/a'}` }],
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error('why failed')
    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match?.[0] ?? '{}') as { why_it_works?: string }
    const whyItWorks = String(parsed.why_it_works ?? '').trim() || inferWhyFromAttrs(attrs)
    return { attrs, whyItWorks }
  } catch (err) {
    console.warn('[reference-vision] why-it-works analysis failed:', err instanceof Error ? err.message : err)
    return { attrs, whyItWorks: inferWhyFromAttrs(attrs) }
  }
}

function inferWhyFromAttrs(attrs: ReferenceAttrs): string {
  const parts = [
    attrs.composition && `${attrs.composition} composition`,
    attrs.lighting && `${attrs.lighting} light`,
    attrs.background && `${attrs.background} background`,
    attrs.mood && `${attrs.mood} mood`,
  ].filter(Boolean)
  return parts.length
    ? `Proven pattern: ${parts.join(', ')} — apply structure to ALMA garments, not competitor branding.`
    : 'Clean garment-forward composition with premium lighting — apply structure to ALMA garments.'
}
