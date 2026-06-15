// Worker → App callback. Authenticated with AGENT_INTERNAL_TOKEN (constant-time compare).
// Does NOT use session auth — workers have no session cookie.
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import { buildOutboundDialMessage } from '@/agent/lib/outbound-call-tracking'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { prisma } from '@/lib/prisma'

const IMAGE_SIGNED_URL_TTL_SEC = 3600

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

function resolveConversationId(action: { conversationId?: string | null; payload: unknown }) {
  const payload = action.payload as Record<string, unknown>
  const id = action.conversationId ?? payload.conversationId
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

function normalizeJobStatus(raw: string): 'success' | 'failed' | null {
  if (raw === 'success') return 'success'
  if (raw === 'failed') return 'failed'
  // Legacy worker bug — treat as success so completed calls are not marked failed.
  if (raw === 'executed') {
    console.warn('[job-result] legacy status "executed" normalized to success')
    return 'success'
  }
  return null
}

interface JobResultBody {
  pendingActionId: string
  status: string
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

  const { pendingActionId, status: rawStatus, data, error } = body
  if (!pendingActionId || !rawStatus) {
    return Response.json({ error: 'pendingActionId and status required' }, { status: 400 })
  }

  const status = normalizeJobStatus(rawStatus)
  if (!status) {
    console.error('[job-result] invalid status:', rawStatus)
    return Response.json({ error: 'invalid_status', allowed: ['success', 'failed'] }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: pendingActionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })

  if (action.status === 'executed' || action.status === 'failed') {
    return Response.json({ ok: true, idempotent: true, status: action.status })
  }

  await db.agentPendingAction.update({
    where: { id: pendingActionId },
    data: {
      status: status === 'success' ? 'executed' : 'failed',
      result: data ?? { error },
      resolvedAt: new Date(),
    },
  })

  const payload = action.payload as Record<string, unknown>
  const convId = resolveConversationId(action)
  let messageText: string | null = null
  let pushTelegram = false

  if (action.type === 'outbound_call' && status === 'success') {
    const phone = String(payload.phone ?? '')
    const callSid = typeof data?.callSid === 'string' ? data.callSid : undefined
    messageText = buildOutboundDialMessage(phone, callSid)
    pushTelegram = true
  } else if (status === 'success' && (data?.storagePath || data?.imageUrl)) {
    const storagePath = typeof data?.storagePath === 'string' ? data.storagePath.trim() : ''
    const cp = payload.contentPipeline as { gate1Id?: string } | undefined
    if (cp?.gate1Id && storagePath) {
      try {
        const { onPipelineRenderComplete } = await import('@/lib/content-engine/pipeline')
        await onPipelineRenderComplete(pendingActionId, storagePath)
      } catch (pipeErr) {
        console.error('[job-result] content pipeline advance failed:', pipeErr)
      }
      messageText = null
    } else {
      try {
        const imageUrl = storagePath
          ? await agentStorageSignedUrl(storagePath, IMAGE_SIGNED_URL_TTL_SEC)
          : String(data?.imageUrl ?? '')
        if (!imageUrl) throw new Error('No image path in job result')
        messageText = `✅ Image generated successfully.\n![Generated image](${imageUrl})`
      } catch (signErr) {
        const detail = signErr instanceof Error ? signErr.message : String(signErr)
        console.error('[job-result] signed URL failed', { storagePath, detail })
        messageText = storagePath
          ? `✅ Image generated and saved.\nPath: \`${storagePath}\`\n(Preview link could not be created — check Supabase storage config.)`
          : `✅ Image generated but preview unavailable.`
      }
    }
  } else if (action.type === 'outbound_call' && status === 'failed') {
    messageText = `❌ স্যার, কল দেওয়া যায়নি।\nকারণ: ${error ?? String(data?.error ?? 'Unknown error')}`
    pushTelegram = true
  } else if (status === 'failed') {
    messageText = `❌ কাজটি সম্পাদন ব্যর্থ হয়েছে।\nকারণ: ${error ?? 'Unknown error'}`
  } else if (status === 'success') {
    messageText = `✅ কাজটি সফলভাবে সম্পাদিত হয়েছে।`
  }

  if (convId && messageText) {
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

  if (pushTelegram && messageText) {
    const tg = await sendOwnerText(messageText)
    if (!tg.ok) console.warn('[job-result] owner telegram notify failed:', tg.error)
  }

  return Response.json({ success: true })
}
