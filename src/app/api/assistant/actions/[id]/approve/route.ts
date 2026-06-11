import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { createPagePost, verifyPost, resolvePageId } from '@/agent/lib/meta'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const actionId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: actionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })
  if (action.status !== 'pending') {
    return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
  }

  // Check expiry (30 min)
  const ageMs = Date.now() - new Date(action.createdAt).getTime()
  if (ageMs > 30 * 60 * 1000) {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'expired', resolvedAt: new Date() },
    })
    return Response.json({ error: 'expired' }, { status: 410 })
  }

  const payload = action.payload as Record<string, unknown>

  // ── Execute by type ────────────────────────────────────────────────────────

  if (action.type === 'fb_post') {
    try {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'approved', resolvedAt: new Date() },
      })

      const pageId = String(payload.pageId ?? resolvePageId(String(payload.page ?? 'lifestyle')))
      const message = String(payload.message ?? '')
      const imageUrl = payload.imageUrl ? String(payload.imageUrl) : undefined

      const { postId } = await createPagePost({ pageId, message, imageUrl })

      // Self-verify
      const verified = await verifyPost(pageId, postId)

      const result = { postId, pageId, verified }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result },
      })

      // Append result to conversation if present
      if (payload.conversationId) {
        const note = verified
          ? `✅ Facebook post published successfully.\nPost ID: ${postId}`
          : `⚠️ Post created (ID: ${postId}) but self-verification failed — check the page.`
        await db.agentMessage.create({
          data: {
            conversationId: String(payload.conversationId),
            role: 'assistant',
            content: [{ type: 'text', text: note }],
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

      return Response.json({ success: true, ...result })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  if (action.type === 'image_gen') {
    // Mark as approved — the VPS worker polls /api/assistant/internal/pending-jobs
    // and picks this up via BullMQ (worker-side queue). No BullMQ dependency in Next.js.
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'approved', resolvedAt: new Date() },
    })

    return Response.json({
      success: true,
      queued: true,
      message: 'Image generation approved. The VPS worker will process it shortly — result will appear in the conversation.',
    })
  }

  return Response.json({ error: 'unknown_action_type', type: action.type }, { status: 400 })
}
