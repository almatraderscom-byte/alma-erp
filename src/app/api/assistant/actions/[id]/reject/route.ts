import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { isPendingActionExpired } from '@/agent/lib/pending-action'
import { recordRejection } from '@/agent/lib/trust-engine'

export const runtime = 'nodejs'

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

  if (isPendingActionExpired(action.createdAt)) {
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
  void recordRejection(trustDomain, action.type as string, trustBiz).catch((err) => {
    console.warn('[reject] recordRejection failed:', err instanceof Error ? err.message : err)
  })

  const payload = action.payload as Record<string, unknown>

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
