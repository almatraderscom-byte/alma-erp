/**
 * Attachment vision pre-reader — reads uploaded images / PDFs with Gemini Flash
 * (cheap) and returns a plain-text transcription, so ANY head model (including
 * text-only ones like DeepSeek) can answer about the attachment without us paying
 * Claude's vision price or switching the owner's chosen model.
 *
 * Flow: chat route persists the owner turn → if it carries an image/PDF, this runs
 * once, and the transcription is stored as a text block in the message. From then
 * on it lives in history like any other text, visible to every adapter.
 */
import { logCost } from '@/agent/lib/cost-events'
import { agentStorageDownload } from '@/agent/lib/storage'

const VISION_MODEL = 'gemini-2.5-flash'

const READ_PROMPT = `এই সংযুক্ত ছবি/ডকুমেন্টটি মনোযোগ দিয়ে পড়ো এবং এমনভাবে বর্ণনা দাও যাতে যিনি ছবিটা দেখেননি তিনিও সব বুঝতে পারেন।
- সব দৃশ্যমান লেখা (বাংলা/English/সংখ্যা/টাকার অঙ্ক/তারিখ/ফোন নম্বর/অর্ডার আইডি) হুবহু তুলে দাও — কিছু বাদ দিও না।
- টেবিল বা তালিকা থাকলে গঠন রেখে লেখো।
- স্ক্রিনশট হলে কোন স্ক্রিন/অ্যাপ এবং মূল তথ্যগুলো বলো।
- শুধু যা আসলে দেখা যাচ্ছে তা-ই লেখো — অনুমান বা বানানো তথ্য নয়।`

interface AttachmentLite {
  path: string
  mediaType: string
}

function isVisual(mediaType: string): boolean {
  return mediaType.startsWith('image/') || mediaType === 'application/pdf'
}

export function hasVisualAttachment(files: AttachmentLite[]): boolean {
  return files.some((f) => isVisual(f.mediaType))
}

/**
 * Stable marker that opens every stored vision-note text block. `loadHistory` keys
 * off it to know the attachment was already read by Gemini, so it does NOT re-embed
 * the raw base64 image into a Claude turn (which would re-pay for vision we already
 * did cheaply). Must stay a literal prefix of both note variants below.
 */
export const VISION_NOTE_PREFIX = '[সংযুক্ত ছবি/ফাইল'

/** Builds the stored text block carrying Gemini's reading (or an honest failure note). */
export function buildVisionNoteBlock(visionText: string | null): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: visionText
      ? `${VISION_NOTE_PREFIX} Gemini Vision দিয়ে পড়া হয়েছে — নিচের বিবরণ ব্যবহার করে স্যারকে উত্তর দাও:\n${visionText}]`
      : `${VISION_NOTE_PREFIX}টি পড়া যায়নি (vision সার্ভিস সাড়া দেয়নি)। স্যারকে স্পষ্ট জানাও যে ছবিটা পড়া যায়নি এবং আবার পাঠাতে বলো — দেখেছ এমন ভান কোরো না।]`,
  }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

async function geminiReadText(base64: string, mimeType: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: READ_PROMPT },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1500 },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Gemini vision HTTP ${res.status}: ${err.slice(0, 160)}`)
  }

  const data = (await res.json()) as GeminiResponse
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()

  void logCost({
    provider: 'gemini',
    kind: 'cs_vision',
    units: {
      model: VISION_MODEL,
      purpose: 'attachment_read',
      tokens_in: data.usageMetadata?.promptTokenCount ?? 600,
      tokens_out: data.usageMetadata?.candidatesTokenCount ?? 300,
    },
    costUsd: 0.0002,
    dedupKey: `vision:attach:${base64.slice(0, 32)}`,
  })

  return text
}

/**
 * Transcribes every image/PDF in `files` with Gemini and returns a single combined
 * description string, or null if there's nothing visual / the read produced nothing.
 * Per-file failures are swallowed (logged) so one bad file can't sink the turn — the
 * caller distinguishes "no visual attachment" (null, no note) from "read failed"
 * (empty after visuals existed) via the boolean it already computed.
 */
export async function describeAttachments(files: AttachmentLite[]): Promise<string | null> {
  const visual = files.filter((f) => isVisual(f.mediaType))
  if (visual.length === 0) return null

  const parts: string[] = []
  for (let i = 0; i < visual.length; i++) {
    const f = visual[i]
    try {
      const buffer = await agentStorageDownload(f.path)
      const base64 = buffer.toString('base64')
      const text = await geminiReadText(base64, f.mediaType)
      if (text) parts.push(visual.length > 1 ? `[ফাইল ${i + 1}]\n${text}` : text)
    } catch (err) {
      console.warn('[attachment-vision] read failed:', f.path, err instanceof Error ? err.message : err)
    }
  }

  return parts.length ? parts.join('\n\n') : null
}
