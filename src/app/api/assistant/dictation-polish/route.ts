import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import OpenAI from 'openai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

/**
 * Dictation polish (owner research 2026-07-23): raw realtime STT text →
 * clean, natural Bangla. Fixes Banglish spellings, chunk-boundary artifacts
 * from the streaming commits, and punctuation — WITHOUT adding or dropping
 * content. Model owner-tunable via DICTATION_POLISH_MODEL.
 */
/** Owner env override first, then real model names newest-first — the first
 * one the account accepts wins and is remembered for the process lifetime
 * (ChatGPT suggested 'gpt-5.6-mini', which does not exist on the API). */
const POLISH_LADDER = [
  process.env.DICTATION_POLISH_MODEL?.trim() || '',
  'gpt-5.6-luna',
  'gpt-5.1-mini',
  'gpt-5-mini',
  'gpt-4.1-mini',
  'gpt-4o-mini',
].filter(Boolean)
let workingModel: string | null = null

const SYSTEM = `তুমি একজন বাংলা লেখা-পরিষ্কারক। ভয়েস-ডিক্টেশনের কাঁচা transcript পাবে — Banglish, ভাঙা টুকরো, ভুল যতি থাকতে পারে।
নিয়ম:
- অর্থ, সংখ্যা, টাকার অংক, নাম (ALMA, CDIT, Telegram ইত্যাদি) হুবহু রাখবে।
- Banglish শব্দ সুন্দর প্রমিত বাংলায় লিখবে; ইংরেজি brand/technical শব্দ ইংরেজিতেই থাকবে।
- টুকরো-জোড়ার খুঁত (ভাঙা/দুবার-আসা শব্দ) মসৃণ করবে; নিজের থেকে কিছু যোগ বা বাদ দেবে না।
- শুধু পরিষ্কার করা লেখাটুকু ফেরত দেবে — কোনো ব্যাখ্যা, উদ্ধৃতি-চিহ্ন বা ভূমিকা নয়।`

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: 'OPENAI_API_KEY সেট করা নেই।' }, { status: 503 })
  }

  const body = (await req.json().catch(() => ({}))) as { text?: string }
  const raw = String(body.text || '').trim()
  if (!raw) return Response.json({ error: 'text required' }, { status: 400 })
  if (raw.length > 4000) return Response.json({ text: raw, model: 'passthrough_too_long' })

  const started = Date.now()
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const candidates = workingModel ? [workingModel] : POLISH_LADDER
    let lastErr: unknown = null
    for (const model of candidates) {
      try {
        const completion = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: raw },
          ],
          // Newer models (gpt-5.6-luna) reject max_tokens and pinned temperature.
          max_completion_tokens: 1200,
        })
        const text = completion.choices[0]?.message?.content?.trim()
        workingModel = model
        return Response.json({
          text: text && text.length > 0 ? text : raw,
          model,
          ms: Date.now() - started,
        })
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        if (!/does not exist|do not have access|model_not_found/i.test(msg)) throw err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  } catch (err) {
    // Polish is best-effort — the raw transcript is always usable.
    return Response.json({
      text: raw,
      model: 'passthrough_error',
      error: err instanceof Error ? err.message.slice(0, 160) : String(err),
      ms: Date.now() - started,
    })
  }
}
