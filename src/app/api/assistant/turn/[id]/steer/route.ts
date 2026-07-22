import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

interface SteeringFileRef {
  bucket?: unknown
  path?: unknown
  mediaType?: unknown
}
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const turnId = params.id
  const clientMessageId = String(body.clientMessageId ?? '').trim()
  const message = String(body.message ?? '').trim()
  const files = Array.isArray(body.files) ? body.files as SteeringFileRef[] : []
  if (!clientMessageId || (!message && files.length === 0)) {
    return Response.json({ error: 'clientMessageId_and_content_required' }, { status: 400 })
  }
  if (message.length > 20_000) return Response.json({ error: 'message_too_long' }, { status: 413 })

  const turn = await prisma.agentTurn.findUnique({
    where: { id: turnId },
    select: { id: true, conversationId: true, status: true },
  })
  if (!turn) return Response.json({ error: 'turn_not_found' }, { status: 404 })
  if (turn.status !== 'running') {
    return Response.json({ error: 'turn_not_running', status: turn.status }, { status: 409 })
  }

  const content: Array<Record<string, string>> = []
  if (message) content.push({ type: 'text', text: message })
  for (const file of files) {
    const bucket = String(file.bucket ?? '').trim()
    const path = String(file.path ?? '').trim()
    const mediaType = String(file.mediaType ?? 'application/octet-stream').trim()
    if (bucket && path) content.push({ type: 'file_ref', bucket, path, mediaType })
  }

  const existing = await prisma.agentMessage.findUnique({
    where: { clientRequestId: clientMessageId },
    select: { id: true, conversationId: true },
  })
  if (existing) {
    if (existing.conversationId !== turn.conversationId) {
      return Response.json({ error: 'client_message_conflict' }, { status: 409 })
    }
    return Response.json({ success: true, messageId: existing.id, duplicate: true, turnId })
  }

  try {
    const row = await prisma.agentMessage.create({
      data: {
        conversationId: turn.conversationId,
        clientRequestId: clientMessageId,
        role: 'user',
        content,
        usage: {
          steering: {
            targetTurnId: turnId,
            status: 'queued',
            queuedAt: new Date().toISOString(),
          },
        },
      },
      select: { id: true },
    })
    await prisma.agentConversation.update({
      where: { id: turn.conversationId },
      data: { updatedAt: new Date() },
    })
    return Response.json({ success: true, messageId: row.id, duplicate: false, turnId })
  } catch (err) {
    // A retry can race the first request between findUnique and create. The
    // unique clientRequestId is authoritative; return that same logical send.
    const raced = await prisma.agentMessage.findUnique({
      where: { clientRequestId: clientMessageId }, select: { id: true, conversationId: true },
    })
    if (raced?.conversationId === turn.conversationId) {
      return Response.json({ success: true, messageId: raced.id, duplicate: true, turnId })
    }
    console.warn('[turn-steer] persist failed:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'persist_failed' }, { status: 500 })
  }
}
