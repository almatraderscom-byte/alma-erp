/**
 * Vision attrs for fashion creative taste learning.
 */
const TASTE_VISION_PROMPT = `Describe this fashion creative's concrete visual attributes for taste learning.
Return JSON only:
{
  "composition": "centered|rule-of-thirds|full-body|detail|other",
  "crop": "tight|medium|full-body|three-quarter",
  "model_pose": "relaxed|stiff|walking|turning|other",
  "background": "studio-clean|outdoor|busy|minimal|golden-hour|other",
  "lighting": "soft|hard|golden-hour|flat|natural",
  "dominant_colors": ["..."],
  "mood": "premium|casual|festive|cheap|other",
  "text_overlay": "none|minimal|busy"
}`

export type TasteAttrs = {
  composition?: string
  crop?: string
  model_pose?: string
  background?: string
  lighting?: string
  dominant_colors?: string[]
  mood?: string
  text_overlay?: string
}

export async function describeCreativeTaste(imageBase64: string, mimeType: string): Promise<TasteAttrs> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: TASTE_VISION_PROMPT },
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Taste vision HTTP ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  return JSON.parse(jsonMatch?.[0] ?? '{}') as TasteAttrs
}
