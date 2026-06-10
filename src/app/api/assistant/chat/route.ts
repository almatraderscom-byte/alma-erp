import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { runAgentTurn } from '@/agent/lib/core'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!isSystemOwner(token)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { conversationId?: string; message?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) {
    return Response.json({ error: 'message_required' }, { status: 400 })
  }

  // Resolve or create conversation.
  let conversationId = typeof body.conversationId === 'string' ? body.conversationId : null

  if (conversationId) {
    const exists = await prisma.agentConversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    })
    if (!exists) {
      return Response.json({ error: 'conversation_not_found' }, { status: 404 })
    }
  } else {
    const conv = await prisma.agentConversation.create({
      data: {
        title: message.slice(0, 60) || null,
        model: 'claude-sonnet-4-6',
      },
      select: { id: true },
    })
    conversationId = conv.id
  }

  // Persist the user message before streaming so it's durably saved.
  await prisma.agentMessage.create({
    data: {
      conversationId,
      role: 'user',
      content: [{ type: 'text', text: message }] as unknown as Parameters<
        typeof prisma.agentMessage.create
      >[0]['data']['content'],
    },
  })

  // Build SSE response stream.
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      // First event carries the conversationId so the client knows which conversation was created.
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'conversation_id', id: conversationId })}\n\n`),
      )
      try {
        for await (const event of runAgentTurn(conversationId!)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          if (event.type === 'done' || event.type === 'error') break
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`),
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Conversation-Id': conversationId!,
    },
  })
}
