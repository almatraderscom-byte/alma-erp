// Worker → App callback. Authenticated with AGENT_INTERNAL_TOKEN (constant-time compare).
// Does NOT use session auth — workers have no session cookie.
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

interface JobResultBody {
  pendingActionId: string
  status: 'success' | 'failed'
  data?: Record<string, unknown>
  error?: string
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: JobResultBody
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { pendingActionId, status, data, error } = body
  if (!pendingActionId || !status) {
    return Response.json({ error: 'pendingActionId and status required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: pendingActionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })

  await db.agentPendingAction.update({
    where: { id: pendingActionId },
    data: {
      status: status === 'success' ? 'executed' : 'failed',
      result: data ?? { error },
    },
  })

  // Append result message to conversation
  const payload = action.payload as Record<string, unknown>
  if (payload.conversationId) {
    const convId = String(payload.conversationId)
    let messageText: string

    if (status === 'success' && data?.imageUrl) {
      messageText = `✅ Image generated successfully.\n![Generated image](${data.imageUrl})`
    } else if (status === 'success' && data?.storagePath) {
      messageText = `✅ Image saved to storage: ${data.storagePath}`
    } else if (status === 'failed') {
      messageText = `❌ কাজটি সম্পাদন ব্যর্থ হয়েছে।\nকারণ: ${error ?? 'Unknown error'}`
    } else {
      messageText = `✅ কাজটি সফলভাবে সম্পাদিত হয়েছে।`
    }

    await db.agentMessage.create({
      data: {
        conversationId: convId,
        role: 'assistant',
        content: [{ type: 'text', text: messageText }],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      },
    })
    await prisma.agentConversation.update({
      where: { id: convId },
      data: { updatedAt: new Date() },
    })
  }

  return Response.json({ success: true })
}
