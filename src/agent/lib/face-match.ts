/**
 * Gemini-based person identification for camera frames.
 *
 * Sends the registered reference photos (known-people.ts) + one CCTV frame in a
 * single multi-image request and asks the model to name each visible person or
 * mark them unknown. Same Flash-scan → Pro-confirm pattern as idle-detection:
 * Flash reads every frame; Pro re-checks when a stranger is suspected OR when a
 * named match is shaky (<0.85), so neither a false "অপরিচিত" alarm nor a
 * wrong-name announcement survives while cost stays near Flash.
 *
 * This matches ONLY against photos the owner registered for his own office
 * security — it never tries to identify arbitrary people.
 */
import { logCost } from '@/agent/lib/cost-events'
import { loadKnownPeopleWithImages, type KnownPersonWithImages } from '@/agent/lib/known-people'

const FLASH_MODEL = 'gemini-2.5-flash'
const PRO_MODEL = 'gemini-2.5-pro'

// Keep in sync with vision-analyze.ts VISION_PRICES.
const PRICES: Record<string, { in: number; out: number }> = {
  [FLASH_MODEL]: { in: 0.3, out: 2.5 },
  [PRO_MODEL]: { in: 1.25, out: 10 },
}

export interface IdentifiedPerson {
  known: boolean
  /** Registered name when known, null otherwise. */
  name: string | null
  confidence: number
  /** Short visual description (clothing/position) — useful for strangers. */
  description: string
}

export interface FaceMatchResult {
  peopleCount: number
  people: IdentifiedPerson[]
  /** True when at least one visible person matched no registered reference. */
  strangerPresent: boolean
  summaryBn: string
  model: 'flash' | 'pro'
  /** False when no reference photos are registered (identification skipped). */
  hadReferences: boolean
}

interface RawMatch {
  people_count?: number
  people?: Array<{
    known?: boolean
    name?: string | null
    confidence?: number
    description?: string
  }>
  summary_bn?: string
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

function buildPrompt(refs: KnownPersonWithImages[]): string {
  const roster = refs
    .map((p, i) => `PERSON ${i + 1}: "${p.name}" (${p.role}) — ${p.images.length} reference photo(s) follow this prompt in order.`)
    .join('\n')
  return `You are a security assistant for a small office. You will receive REFERENCE PHOTOS of known people, then one CCTV FRAME (wide-angle, possibly black & white night vision, faces may be small or at an angle).

Known people roster:
${roster}

The FINAL image is the CCTV frame to analyze. For EVERY person visible in that frame, decide whether they are one of the known people above by comparing face, build, hair and overall appearance against the reference photos.

Return ONLY this JSON (no prose):
{
  "people_count": <integer — people visible in the CCTV frame>,
  "people": [
    {
      "known": <true only if you are reasonably sure this is one of the roster people>,
      "name": <the exact roster name when known, else null>,
      "confidence": <0.0-1.0 — how sure you are about THIS person's identity decision>,
      "description": "<very short: clothing colour + where they are in the frame>"
    }
  ],
  "summary_bn": "<one short Bengali sentence: who is visible / whether anyone is unrecognized>"
}

Rules:
- NEVER guess a name that is not on the roster. If unsure between roster/no-roster, set known=false and lower confidence.
- Naming the WRONG person is far worse than saying unknown (owner incident: a visitor
  was announced as the owner). Mark known=true ONLY when the FACE clearly matches a
  reference photo — clothing colour, build or hairstyle alone is NEVER enough.
- If the face is not clearly visible (turned away, too small, blurred, blocked),
  set known=false even if the silhouette resembles someone.
- Check apparent gender and age band FIRST: if they contradict the reference person,
  it is NOT them, no matter how similar the clothing looks.
- Empty frame: people_count 0, people [].
- One entry per visible person, in any order.`
}

async function callGemini(
  model: string,
  refs: KnownPersonWithImages[],
  frame: { base64: string; mimeType: string },
  costKind: string,
): Promise<RawMatch> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const parts: Array<Record<string, unknown>> = [{ text: buildPrompt(refs) }]
  for (const person of refs) {
    for (const img of person.images) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } })
    }
  }
  parts.push({ text: 'CCTV FRAME to analyze:' })
  parts.push({ inline_data: { mime_type: frame.mimeType, data: frame.base64 } })

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: model.includes('pro') ? 256 : 0 },
        },
      }),
      signal: AbortSignal.timeout(45_000),
    },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini face-match HTTP ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = (await res.json()) as GeminiResponse
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    const finishReason = data.candidates?.[0]?.finishReason ?? 'unknown'
    throw new Error(`Gemini face-match returned no JSON (finishReason=${finishReason})`)
  }

  const tokensIn = data.usageMetadata?.promptTokenCount ?? 2000
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 200
  const price = PRICES[model] ?? PRICES[FLASH_MODEL]!
  void logCost({
    provider: 'gemini',
    kind: costKind as 'cs_vision',
    units: { model, tokens_in: tokensIn, tokens_out: tokensOut },
    costUsd: (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out,
    dedupKey: `face-match:${costKind}:${model}:${frame.base64.slice(0, 24)}`,
  })

  return JSON.parse(jsonMatch[0]) as RawMatch
}

function normalize(raw: RawMatch, refs: KnownPersonWithImages[], model: 'flash' | 'pro'): FaceMatchResult {
  const rosterNames = new Set(refs.map((r) => r.name))
  const people: IdentifiedPerson[] = (raw.people ?? []).map((p) => {
    const name = p.name && rosterNames.has(p.name) ? p.name : null
    // Hard confidence floor: a low-confidence "known" is treated as unknown so a
    // borderline lookalike can never be announced by name (2026-07-12 incident).
    const confident = typeof p.confidence !== 'number' || p.confidence >= 0.65
    const known = p.known === true && !!name && confident
    return {
      known,
      name: known ? name : null,
      confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
      description: (p.description ?? '').slice(0, 120),
    }
  })
  return {
    peopleCount: raw.people_count ?? people.length,
    people,
    strangerPresent: people.some((p) => !p.known),
    summaryBn: (raw.summary_bn ?? '').slice(0, 200),
    model,
    hadReferences: true,
  }
}

/**
 * Identify people in one camera frame against the registered known-people.
 * Flash first; if Flash claims a stranger (the actionable, alarm-raising case),
 * confirm with Pro before trusting it. Throws on total failure — callers wrap.
 */
export async function identifyPeopleInFrame(frame: {
  base64: string
  mimeType: string
}): Promise<FaceMatchResult> {
  const refs = await loadKnownPeopleWithImages()
  if (refs.length === 0) {
    return {
      peopleCount: 0, people: [], strangerPresent: false,
      summaryBn: '', model: 'flash', hadReferences: false,
    }
  }

  const flash = normalize(await callGemini(FLASH_MODEL, refs, frame, 'vision_face_match'), refs, 'flash')
  // Pro re-checks BOTH actionable claims: a suspected stranger (false alarm is
  // costly) AND a shaky named match (announcing the wrong person is worse —
  // 2026-07-12: Flash kept naming visitors as the owner). Confident matches
  // (>=0.85) skip the second call so the normal case stays at Flash cost.
  const shakyKnown = flash.people.some((p) => p.known && p.confidence < 0.85)
  if (!flash.strangerPresent && !shakyKnown) return flash
  try {
    return normalize(await callGemini(PRO_MODEL, refs, frame, 'vision_face_match_confirm'), refs, 'pro')
  } catch {
    return flash
  }
}
