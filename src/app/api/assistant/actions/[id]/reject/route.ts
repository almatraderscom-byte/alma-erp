import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { isPendingActionExpired } from '@/agent/lib/pending-action'
import { recordRejection } from '@/agent/lib/trust-engine'
import { getModel, DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'

export const runtime = 'nodejs'
// A rejected delegation makes the Sonnet head answer the task itself (one
// completion). On a cold start + Anthropic latency this can exceed 60s and
// return a Vercel 504 ("HTTP error" toast), so match the approve route's cap.
export const maxDuration = 120

/**
 * Owner chose "Sonnet বলুক" on a delegation card → run the head model directly
 * on the original task and return its Bangla answer (no tools, single turn).
 */
async function runHeadDirectAnswer(task: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const model = getModel(DEFAULT_MODEL_ID)
  const system =
    'তুমি ALMA-র হেড অ্যাসিস্ট্যান্ট (Sonnet)। মালিক worker-কে কাজটা না দিয়ে চেয়েছেন তুমি নিজে উত্তর দাও। ' +
    'নিচের কাজটির জন্য সরাসরি, ব্যবহারিক, তথ্যবহুল বাংলা উত্তর দাও — মালিককে "Boss" বলে সম্বোধন করো। ' +
    'অপ্রয়োজনীয় ভূমিকা নয়, ইসলামিক গাইডরেল মেনে চলো।'
  const resp = await client.messages.create({
    model: model.apiModel,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: task }],
  })
  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  return { text, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens }
}

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch (err) {
    console.warn('[reject] token compare failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const actionId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: actionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })
  if (action.status !== 'pending') {
    return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
  }

  if (isPendingActionExpired(action.createdAt, action.type)) {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'expired', resolvedAt: new Date() },
    })
    return Response.json({ error: 'expired', message: 'অনুমোদনের সময় শেষ — ৩০ মিনিটের মধ্যে সিদ্ধান্ত নিতে হবে।' }, { status: 410 })
  }

  await db.agentPendingAction.update({
    where: { id: actionId },
    data: { status: 'rejected', resolvedAt: new Date() },
  })

  // Record trust rejection (non-blocking)
  const trustDomain = (action.type as string).startsWith('staff_') ? 'staff' :
    ['content_gate1', 'content_gate2', 'fb_post', 'ad_creative_gate', 'ads_creative_brief'].includes(action.type as string) ? 'content' :
    (action.type as string).startsWith('website_') ? 'content' :
    (action.type as string).startsWith('log_') || action.type === 'delete_finance_entry' || action.type === 'edit_finance_entry' ? 'finance' :
    'general'
  const trustBiz = (action.businessId as string) ?? 'ALMA_LIFESTYLE'
  // A rejected delegation is NOT a rejection of the work — the owner just chose
  // Sonnet over the worker. Don't pollute the trust engine with it.
  if (action.type !== 'delegation') {
    void recordRejection(trustDomain, action.type as string, trustBiz).catch((err) => {
      console.warn('[reject] recordRejection failed:', err instanceof Error ? err.message : err)
    })
  }

  const payload = action.payload as Record<string, unknown>

  // Delegation rejected → the owner wants Sonnet to answer the task itself.
  if (action.type === 'delegation') {
    const task = String(payload.task ?? '').trim()
    const rawConvId = action.conversationId ?? payload.conversationId
    const conversationId = typeof rawConvId === 'string' && rawConvId.trim() ? rawConvId.trim() : null
    let answer = ''
    let tokensIn = 0
    let tokensOut = 0
    try {
      const r = await runHeadDirectAnswer(task)
      answer = r.text
      tokensIn = r.inputTokens
      tokensOut = r.outputTokens
    } catch (err) {
      console.warn('[reject] head direct answer failed:', err instanceof Error ? err.message : err)
      answer = `উত্তর তৈরিতে সমস্যা হলো: ${err instanceof Error ? err.message : String(err)}`
    }
    const note = answer || '(কোনো উত্তর তৈরি হয়নি)'
    const costUsd = calcModelTurnCostUsd(getModel(DEFAULT_MODEL_ID), { inputTokens: tokensIn, outputTokens: tokensOut })
    if (conversationId) {
      await db.agentMessage.create({
        data: {
          conversationId,
          role: 'assistant',
          content: [{ type: 'text', text: note }],
          tokensIn,
          tokensOut,
          costUsd,
          usage: { input_tokens: tokensIn, output_tokens: tokensOut, model: getModel(DEFAULT_MODEL_ID).id, delegation_reject_answer: true },
        },
      })
      await prisma.agentConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      })
      void logCost({
        provider: 'anthropic',
        kind: 'chat',
        units: { input_tokens: tokensIn, output_tokens: tokensOut, model: getModel(DEFAULT_MODEL_ID).id, via: 'delegation_reject_head_answer' },
        costUsd,
        conversationId,
        dedupKey: `delegreject:${actionId}`,
      }).catch(() => {})
    }
    return Response.json({ success: true, status: 'rejected', answered: true })
  }

  if (action.type === 'content_gate1' || action.type === 'ad_creative_gate') {
    try {
      const { captureTasteSignalAsync } = await import('@/agent/lib/taste/capture')
      const pl = payload as { productCode?: string; variants?: Array<{ framedImagePath?: string | null; keep?: boolean }>; storagePath?: string; previewPath?: string }
      if (action.type === 'content_gate1' && pl.variants?.length) {
        for (const v of pl.variants) {
          if (v.framedImagePath) {
            captureTasteSignalAsync({
              verdict: 'reject',
              imagePath: v.framedImagePath,
              productCode: pl.productCode ?? null,
              source: 'content_gate1_reject',
            })
          }
        }
      } else {
        const path = pl.storagePath ?? pl.previewPath
        if (path) {
          captureTasteSignalAsync({
            verdict: 'reject',
            imagePath: path,
            productCode: pl.productCode ?? null,
            source: `${action.type}_reject`,
          })
        }
      }
    } catch (err) {
      console.warn('[reject] taste signal capture failed:', err instanceof Error ? err.message : err)
    }
  }

  // Append rejection note to conversation
  if (payload.conversationId) {
    await db.agentMessage.create({
      data: {
        conversationId: String(payload.conversationId),
        role: 'assistant',
        content: [{ type: 'text', text: 'Action rejected by owner.' }],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      },
    })
    await prisma.agentConversation.update({
      where: { id: String(payload.conversationId) },
      data: { updatedAt: new Date() },
    })
  }

  return Response.json({ success: true, status: 'rejected' })
}
