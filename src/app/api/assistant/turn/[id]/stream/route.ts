import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getTurnStatus } from '@/agent/lib/turn-status'
import {
  createSeqDeduper,
  getReplayEvents,
  isTerminalEventType,
  sseFrame,
  subscribeTurnEvents,
} from '@/agent/lib/turn-events'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Live stream of a worker-executed turn (Component A2).
 *
 * Replays the durable `agent_turn_events` log (so a client that reconnects after
 * backgrounding sees everything it missed), then tails the Redis pub/sub channel
 * for newer events. Emission is deduped by `seq` because the replay and the live
 * tail overlap by design. Closes when a terminal (done/error) event is seen.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id: turnId } = await Promise.resolve(params)
  if (!turnId) return Response.json({ error: 'turn_id_required' }, { status: 400 })

  const encoder = new TextEncoder()
  const dedup = createSeqDeduper()

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      let keepAlive: ReturnType<typeof setInterval> | undefined
      let sub: { close: () => Promise<void> } | null = null

      const safeEnqueue = (frame: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          /* stream already closed */
        }
      }
      const finish = () => {
        if (closed) return
        closed = true
        if (keepAlive) clearInterval(keepAlive)
        void sub?.close()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      // 1) Replay the durable log. If it already ended terminally, we're done.
      const replay = await getReplayEvents(turnId)
      let sawTerminal = false
      for (const evt of replay) {
        if (!dedup.accept(evt.seq)) continue
        safeEnqueue(sseFrame(evt.payload))
        if (isTerminalEventType(evt.type)) sawTerminal = true
      }
      if (sawTerminal) return finish()

      // 2) Tail the live channel for events newer than the replay.
      sub = await subscribeTurnEvents(turnId, (evt) => {
        if (!dedup.accept(evt.seq)) return
        safeEnqueue(sseFrame(evt.payload))
        if (isTerminalEventType(evt.type)) finish()
      })
      if (!sub) {
        // Redis unavailable: if the turn already reached a terminal state, close
        // cleanly (client falls back to status polling); otherwise nothing to tail.
        const status = await getTurnStatus(turnId)
        if (status !== 'running') {
          safeEnqueue(sseFrame({ type: 'error', message: 'turn_stream_unavailable' }))
        }
        return finish()
      }

      // Keepalive so idle proxies don't drop the stream during long tool steps.
      keepAlive = setInterval(() => safeEnqueue(`: ping\n\n`), 10_000)

      // Abort if the client disconnects (app backgrounded): the worker keeps
      // running and the durable log lets a later reconnect replay the rest.
      req.signal.addEventListener('abort', finish)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
