/**
 * POST /api/assistant/internal/assess-task-proof
 * Lightweight vision/text check — does proof match the task?
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL } from '@/agent/config'
import { runAutoQc, formatQcNotification, SHADOW_MODE } from '@/agent/lib/auto-qc'

export const runtime = 'nodejs'
export const maxDuration = 30

const TRUSTED_IMAGE_HOSTS = new Set([
  'api.telegram.org',
  'scontent.xx.fbcdn.net',
  'lookaside.fbsbx.com',
  'platform-lookaside.fbsbx.com',
])

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function isTrustedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (TRUSTED_IMAGE_HOSTS.has(parsed.hostname)) return true
    if (parsed.hostname.endsWith('.fbcdn.net')) return true
    if (parsed.hostname.endsWith('.supabase.co')) return true
    if (parsed.hostname.endsWith('.cdninstagram.com')) return true
    return false
  } catch {
    return false
  }
}

async function fetchImageSafe(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  if (!isTrustedImageUrl(url)) {
    console.warn('[assess-task-proof] rejected untrusted image URL:', url.slice(0, 120))
    return null
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return null
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  if (contentLength > MAX_IMAGE_BYTES) {
    console.warn('[assess-task-proof] image too large:', contentLength)
    return null
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_IMAGE_BYTES) return null
  const mime = res.headers.get('content-type')?.startsWith('image/')
    ? res.headers.get('content-type')!
    : 'image/jpeg'
  return { buf, mime }
}

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

const CONTENT_TYPES = new Set(['ad_creative', 'product_content', 'product_photo', 'video_reel'])

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    taskTitle?: string
    taskDetail?: string
    taskType?: string
    proofImageUrl?: string
    proofText?: string
  }

  const taskType = body.taskType ?? ''
  if (!CONTENT_TYPES.has(taskType)) {
    return NextResponse.json({ matches: true, confidence: 'low', note: 'not_content_type' })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ matches: true, confidence: 'low', note: 'no_api_key' })
  }

  const proofText = typeof body.proofText === 'string' ? body.proofText.trim() : ''
  const proofImageUrl = typeof body.proofImageUrl === 'string' ? body.proofImageUrl.trim() : ''
  if (!proofText && !proofImageUrl) {
    return NextResponse.json({ matches: true, confidence: 'low', note: 'no_proof' })
  }

  try {
    const taskDesc = `${body.taskTitle ?? 'Task'}${body.taskDetail ? `. ${body.taskDetail}` : ''}`

    const userContent: Anthropic.Messages.ContentBlockParam[] = [
      {
        type: 'text',
        text:
          `Staff task (Bangla business): ${taskDesc}\n` +
          `Does the submitted proof show this task was actually done?\n` +
          `Reply JSON only: {"matches":true|false,"confidence":"high"|"low","note":"one line Bangla"}`,
      },
    ]

    let cachedImage: { buf: Buffer; mime: string } | null = null
    if (proofImageUrl) {
      cachedImage = await fetchImageSafe(proofImageUrl)
      if (cachedImage) {
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: cachedImage.mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: cachedImage.buf.toString('base64'),
          },
        })
      }
    } else if (proofText) {
      userContent.push({
        type: 'text',
        text: `Text proof from staff: ${proofText.slice(0, 1500)}`,
      })
    }

    // Anthropic only when the owner's Monitor toggle + env allow it; otherwise
    // (the current default) the same assessment runs on Gemini vision — the
    // proof check must never depend on Claude being on.
    const { isAnthropicAllowed } = await import('@/agent/lib/models/model-enabled')
    const anthropicAllowed = await isAnthropicAllowed(AGENT_MODEL || 'claude-sonnet-4-6').catch(() => false)

    let raw = '{}'
    if (anthropicAllowed && process.env.ANTHROPIC_API_KEY) {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const res = await client.messages.create({
        model: AGENT_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: userContent }],
      })
      const textBlock = res.content.find((b) => b.type === 'text')
      raw = textBlock && textBlock.type === 'text' ? textBlock.text : '{}'
    } else {
      const promptText = userContent
        .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (cachedImage) {
        const { geminiVisionJson } = await import('@/agent/lib/vision-analyze')
        const out = await geminiVisionJson<Record<string, unknown>>({
          prompt: promptText,
          imageBase64: cachedImage.buf.toString('base64'),
          mimeType: cachedImage.mime,
          costKind: 'task_proof_assess',
          maxTokens: 200,
        })
        raw = JSON.stringify(out)
      } else {
        const { geminiGenerateText } = await import('@/agent/lib/gemini-text')
        raw = await geminiGenerateText({
          prompt: promptText,
          costLabel: 'task_proof_assess_text',
          maxTokens: 200,
          temperature: 0.1,
        })
      }
    }

    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as {
      matches?: boolean
      confidence?: string
      note?: string
    }

    const result = {
      matches: json.matches !== false,
      confidence: json.confidence === 'high' ? 'high' : 'low',
      note: typeof json.note === 'string' ? json.note : '',
      autoQc: undefined as { score?: number; verdict?: string; issues?: string[]; notification?: string } | undefined,
    }

    if (taskType === 'product_photo' && cachedImage) {
      try {
        const qcResult = await runAutoQc(cachedImage.buf.toString('base64'), cachedImage.mime)
        if (qcResult.ran) {
          result.autoQc = {
            score: qcResult.score,
            verdict: qcResult.verdict,
            issues: qcResult.issues,
            notification: qcResult.belowThreshold
              ? formatQcNotification(qcResult, body.taskTitle)
              : undefined,
          }
          if (qcResult.belowThreshold && !SHADOW_MODE) {
            result.matches = false
            result.note = `QC score ${qcResult.score}/100 — threshold এর নিচে`
          }
        }
      } catch (qcErr) {
        console.error('[assess-task-proof] auto-qc error:', qcErr)
      }
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[assess-task-proof]', err)
    return NextResponse.json({ matches: false, confidence: 'low', note: 'assessment_error' })
  }
}
