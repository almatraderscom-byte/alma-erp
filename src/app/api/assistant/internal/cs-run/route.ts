import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runCsTurn } from '@/agent/lib/cs/core'
import { csReplyPermitted } from '@/agent/lib/cs/modes'
import { agentStorageDownload } from '@/agent/lib/storage'
import { checkCsGuards } from '@/agent/lib/cs/guards'
import { appendCsMessage } from '@/agent/lib/cs/conversations'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 60

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch (err) {
    console.warn('[cs-run] token compare failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json() as { jobId?: string; conversationId?: string; messageId?: string }
  const { jobId, conversationId, messageId } = body
  if (!conversationId || !messageId) {
    return Response.json({ error: 'conversationId and messageId required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const conv = await db.csConversation.findUnique({ where: { id: conversationId } })
  if (!conv) return Response.json({ error: 'conversation_not_found' }, { status: 404 })

  const { permitted, effectiveMode } = await csReplyPermitted(conv)
  if (!permitted) {
    if (jobId) {
      await db.csReplyJob.update({
        where: { id: jobId },
        data: { status: 'skipped', processedAt: new Date(), lastError: 'not_permitted' },
      })
    }
    return Response.json({ skipped: true, reason: 'not_permitted', mode: effectiveMode })
  }

  const msg = await db.csMessage.findUnique({ where: { id: messageId } })
  if (!msg) return Response.json({ error: 'message_not_found' }, { status: 404 })

  const blocks = Array.isArray(msg.content) ? msg.content : []
  let userText = ''
  let imageRef: string | undefined
  let imageB64: string | undefined
  let imageMime: string | undefined

  for (const b of blocks) {
    const block = b as { type?: string; text?: string; path?: string; mimeType?: string; url?: string }
    if (block.type === 'text') userText += block.text ?? ''
    if (block.type === 'image_ref' && block.path) {
      imageRef = block.path
      try {
        const buf = await agentStorageDownload(block.path)
        imageB64 = buf.toString('base64')
        imageMime = block.mimeType ?? 'image/jpeg'
      } catch (err) {
        console.warn('[cs-run] image download failed:', err instanceof Error ? err.message : err)
      }
    }
    if (block.type === 'image_url' && block.url) imageRef = block.url
  }

  const shadowOnly = effectiveMode === 'shadow'

  const guard = await checkCsGuards({
    conversationId: conv.id,
    pageId: conv.pageId,
    psid: conv.psid,
    userText: userText.trim(),
  })

  if (!guard.allowed) {
    const sendParts = guard.reason === 'rate_limited' && guard.message
      ? [{ type: 'text', text: guard.message }]
      : []
    if (sendParts.length) {
      await appendCsMessage(conv.id, 'assistant', sendParts)
    }
    if (jobId) {
      await db.csReplyJob.update({
        where: { id: jobId },
        data: { status: 'done', processedAt: new Date(), lastError: guard.reason },
      })
    }
    return Response.json({
      ok: true,
      skipped: sendParts.length === 0,
      reason: guard.reason,
      parts: sendParts,
      shadowOnly: false,
      handedOff: guard.reason === 'spam_silent' && (conv.loopCount ?? 0) >= 4,
    })
  }

  try {
    const result = await runCsTurn({
      csConversationId: conv.id,
      pageId: conv.pageId,
      psid: conv.psid,
      userText: userText.trim(),
      imageRef,
      imageB64,
      imageMime,
      shadowOnly,
    })

    let shadowDraftId: string | null = null
    if (shadowOnly && !result.handedOff) {
      const text = result.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n\n')
      const attachments = result.parts.filter((p): p is { type: 'image'; imageUrl: string } => p.type === 'image').map((p) => ({ imageUrl: p.imageUrl }))
      const draft = await db.csShadowDraft.create({
        data: {
          conversationId: conv.id,
          pageId: conv.pageId,
          psid: conv.psid,
          draftText: text,
          attachments,
          status: 'pending',
        },
      })
      shadowDraftId = draft.id
    } else if (!shadowOnly && !result.handedOff) {
      const { incrementCsReplyCount } = await import('@/agent/lib/cs/guards')
      await incrementCsReplyCount(conv.id)
    }

    if (result.followupHints?.length) {
      const { schedulePriceNoReplyFollowup, scheduleHalfOrderFollowup } = await import('@/agent/lib/cs/followups')
      for (const hint of result.followupHints) {
        if (hint.type === 'price_no_reply') {
          await schedulePriceNoReplyFollowup(conv.id, hint.productLabel, hint.stockLow)
        } else if (hint.type === 'half_order') {
          await scheduleHalfOrderFollowup(conv.id)
        }
      }
    }

    if (jobId) {
      await db.csReplyJob.update({
        where: { id: jobId },
        data: { status: 'done', processedAt: new Date() },
      })
    }

    return Response.json({
      ok: true,
      parts: result.parts,
      shadowOnly,
      shadowDraftId,
      handedOff: result.handedOff,
      costUsd: result.costUsd,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (jobId) {
      await db.csReplyJob.update({
        where: { id: jobId },
        data: { status: 'failed', lastError: message, attempts: { increment: 1 } },
      })
    }
    return Response.json({ error: message }, { status: 500 })
  }
}
