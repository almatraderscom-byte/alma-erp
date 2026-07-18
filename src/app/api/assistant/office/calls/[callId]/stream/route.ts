import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { identifyOfficeCallRequest } from '@/agent/lib/office-call-auth'
import { getCanonicalOfficeCallForParticipant } from '@/agent/lib/office-call-domain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const POLL_MS = 2_000
const STREAM_MS = 50_000

export async function GET(req: NextRequest, { params }: { params: { callId: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const identity = await identifyOfficeCallRequest(req)
  if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.code })
  const callId = params.callId?.trim()
  if (!callId) return Response.json({ error: 'call_required' }, { status: 400 })

  const initial = await getCanonicalOfficeCallForParticipant({
    callId,
    businessId: identity.businessId,
    userId: identity.userId,
  })
  if (!initial) return Response.json({ error: 'not_found' }, { status: 404 })

  const encoder = new TextEncoder()
  let interval: ReturnType<typeof setInterval> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let pumping = false
  let lastVersion = -1

  const cleanup = () => {
    closed = true
    if (interval) clearInterval(interval)
    if (deadline) clearTimeout(deadline)
    interval = null
    deadline = null
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id?: number) => {
        if (closed) return
        const frame = `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        controller.enqueue(encoder.encode(frame))
      }
      const pump = async () => {
        if (closed || pumping) return
        pumping = true
        try {
          const call = await getCanonicalOfficeCallForParticipant({
            callId,
            businessId: identity.businessId,
            userId: identity.userId,
          })
          if (!call) {
            send('call', { id: callId, state: 'ENDED', terminalReason: 'NOT_FOUND' })
            cleanup()
            controller.close()
            return
          }
          if (call.version !== lastVersion) {
            lastVersion = call.version
            send('call', {
              id: call.id,
              state: call.state,
              version: call.version,
              terminalReason: call.terminalReason,
              answeredAt: call.answeredAt,
              connectedAt: call.connectedAt,
              endedAt: call.endedAt,
              updatedAt: call.updatedAt,
            }, call.version)
          } else send('heartbeat', { at: new Date().toISOString() })
        } catch {
          send('heartbeat', { at: new Date().toISOString(), degraded: true })
        } finally {
          pumping = false
        }
      }

      send('ready', { callId, retryMs: 1_500 })
      void pump()
      interval = setInterval(() => { void pump() }, POLL_MS)
      deadline = setTimeout(() => {
        if (closed) return
        send('restart', { callId })
        cleanup()
        controller.close()
      }, STREAM_MS)
      req.signal.addEventListener('abort', cleanup, { once: true })
    },
    cancel() { cleanup() },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
