import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled, requireAnthropicApiKey } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { runAgentTurn } from '@/agent/lib/core'

export const runtime = 'nodejs'
export const maxDuration = 60

interface FileRef { bucket: string; path: string; mediaType: string }

function isAgentDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /agent_(conversations|messages|projects)/i.test(msg)
    || /relation .* does not exist/i.test(msg)
    || /P2021|P2010/.test(msg)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const keyMissing = requireAnthropicApiKey()
  if (keyMissing) return keyMissing

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { conversationId?: string; message?: string; files?: FileRef[] }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return Response.json({ error: 'message_required' }, { status: 400 })

  const files: FileRef[] = Array.isArray(body.files)
    ? body.files.filter((f) => f && typeof f.path === 'string' && typeof f.mediaType === 'string')
    : []

  // Resolve or create conversation.
  let conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
  let projectSystemInstructions: string | null = null

  try {
    if (conversationId) {
      const conv = await prisma.agentConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, projectId: true, project: { select: { systemInstructions: true } } },
      })
      if (!conv) return Response.json({ error: 'conversation_not_found' }, { status: 404 })
      projectSystemInstructions = conv.project?.systemInstructions ?? null
    } else {
      const conv = await prisma.agentConversation.create({
        data: { title: message.slice(0, 60) || null, model: 'claude-sonnet-4-6' },
        select: { id: true },
      })
      conversationId = conv.id
    }

    // Build user message content blocks.
    // File refs come before the text block so Claude sees the attachment context first.
    type StoredBlock = { type: string; [k: string]: unknown }
    const userContent: StoredBlock[] = [
      ...files.map((f) => ({ type: 'file_ref', bucket: f.bucket, path: f.path, mediaType: f.mediaType })),
      { type: 'text', text: message },
    ]

    await prisma.agentMessage.create({
      data: {
        conversationId,
        role: 'user',
        content: userContent as unknown as Parameters<typeof prisma.agentMessage.create>[0]['data']['content'],
      },
    })
  } catch (err) {
    console.error('[assistant/chat] persistence failed', err)
    if (isAgentDbError(err)) {
      return Response.json({
        error: 'agent_db_not_migrated',
        message: 'Agent database tables are missing. Run prisma migrate deploy on production.',
      }, { status: 503 })
    }
    return Response.json({
      error: 'server_error',
      message: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (evt: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`))

      enqueue({ type: 'conversation_id', id: conversationId })
      try {
        for await (const event of runAgentTurn(conversationId!, {
          projectSystemInstructions,
          signal: req.signal,
        })) {
          enqueue(event)
          if (event.type === 'done' || event.type === 'error') break
        }
      } catch (err) {
        if (!req.signal.aborted) {
          enqueue({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
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
