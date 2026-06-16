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
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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

    if (proofImageUrl) {
      const imgRes = await fetch(proofImageUrl)
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer())
        const mime = imgRes.headers.get('content-type')?.startsWith('image/')
          ? (imgRes.headers.get('content-type') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
          : 'image/jpeg'
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mime,
            data: buf.toString('base64'),
          },
        })
      }
    } else if (proofText) {
      userContent.push({
        type: 'text',
        text: `Text proof from staff: ${proofText.slice(0, 1500)}`,
      })
    }

    const res = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: userContent }],
    })

    const textBlock = res.content.find((b) => b.type === 'text')
    const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '{}'
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

    // Auto-QC hook (shadow mode): for product_photo tasks with image proof
    if (taskType === 'product_photo' && proofImageUrl) {
      try {
        const imgRes2 = await fetch(proofImageUrl)
        if (imgRes2.ok) {
          const buf2 = Buffer.from(await imgRes2.arrayBuffer())
          const mime2 = imgRes2.headers.get('content-type')?.startsWith('image/')
            ? imgRes2.headers.get('content-type')!
            : 'image/jpeg'
          const qcResult = await runAutoQc(buf2.toString('base64'), mime2)
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
        }
      } catch (qcErr) {
        console.error('[assess-task-proof] auto-qc error:', qcErr)
      }
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[assess-task-proof]', err)
    return NextResponse.json({ matches: true, confidence: 'low', note: 'assessment_failed' })
  }
}
