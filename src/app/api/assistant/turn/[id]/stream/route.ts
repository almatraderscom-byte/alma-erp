import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getTurnSnapshot } from '@/agent/lib/turn-status'
import {
  createSeqDeduper,
  getReplayEvents,
  isTerminalEventType,
  pollTurnEvents,
  subscribeTurnEvents,
} from '@/agent/lib/turn-events'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Live stream of a durable turn (worker OR inline — both write the same event
 * log since roadmap Phase 3).
 *
 * Replays `agent_turn_events` newer than the client's cursor (`?afterSeq=` or the
 * standard `Last-Event-ID` header — frames carry `id: <seq>` so EventSource
 * reconnects resume automatically), then tails the Redis channel. Emission is
 * seq-deduped because replay and tail overlap by design. Closes after a terminal
 * event; replay is page-capped with cursor continuation for pathological turns.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id: turnId } = await Promise.resolve(params)
  if (!turnId) return Response.json({ error: 'turn_id_required' }, { status: 400 })

  // Replay cursor: ?afterSeq=N wins, else Last-Event-ID, else full replay.
  const parseCursor = (raw: string | null): number => {
    if (!raw) return -1
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : -1
  }
  const afterSeq = Math.max(
    parseCursor(req.nextUrl.searchParams.get('afterSeq')),
    parseCursor(req.headers.get('last-event-id')),
  )

  const encoder = new TextEncoder()
  const dedup = createSeqDeduper(afterSeq)

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
      // `id:` carries the seq so EventSource's automatic Last-Event-ID resume works.
      const emitEvent = (seq: number, payload: unknown) => {
        safeEnqueue(`id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`)
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

      // 0) Connection snapshot — lets the client reconcile turn state instantly
      //    (roadmap 3.5) without a separate status request.
      const snap = await getTurnSnapshot(turnId)
      if (snap) {
        safeEnqueue(`data: ${JSON.stringify({
          type: 'turn_snapshot',
          turnId: snap.id,
          conversationId: snap.conversationId,
          status: snap.status,
          lastSeq: snap.lastSeq,
          assistantMessageId: snap.assistantMessageId,
        })}\n\n`)
      }

      // 1) Replay the durable log after the cursor. Terminal replay closes clean.
      const replay = await getReplayEvents(turnId, dedup.lastSeq)
      let sawTerminal = false
      for (const evt of replay) {
        if (!dedup.accept(evt.seq)) continue
        emitEvent(evt.seq, evt.payload)
        if (isTerminalEventType(evt.type)) sawTerminal = true
      }
      if (sawTerminal) return finish()

      // A page-capped replay that didn't reach the tail: tell the client to
      // continue from the cursor instead of silently skipping ahead.
      if (replay.length > 0 && snap && snap.lastSeq > dedup.lastSeq && replay.length >= 5000) {
        safeEnqueue(`data: ${JSON.stringify({ type: 'replay_continue', afterSeq: dedup.lastSeq })}\n\n`)
        return finish()
      }

      // 2) Tail the live channel for events newer than the replay.
      sub = await subscribeTurnEvents(turnId, (evt) => {
        if (!dedup.accept(evt.seq)) return
        emitEvent(evt.seq, evt.payload)
        if (isTerminalEventType(evt.type)) finish()
      })
      if (!sub) {
        // No Redis. That used to end the stream — and it is exactly the state
        // the shared Upstash has been in since its quota ran out, so a
        // worker-run turn could not be watched at all however healthy the
        // worker was. The durable log is written BEFORE each publish, so it is
        // complete on its own: tail that instead, at ~1s instead of instant.
        const status = snap?.status ?? null
        if (status !== 'running') {
          safeEnqueue(`data: ${JSON.stringify({ type: 'error', message: 'turn_stream_unavailable' })}\n\n`)
          return finish()
        }
        sub = pollTurnEvents(turnId, dedup.lastSeq, (evt) => {
          if (!dedup.accept(evt.seq)) return
          emitEvent(evt.seq, evt.payload)
          if (isTerminalEventType(evt.type)) finish()
        })
      }

      // Keepalive so idle proxies don't drop the stream during long tool steps.
      keepAlive = setInterval(() => safeEnqueue(`: ping\n\n`), 10_000)

      // Abort if the client disconnects (app backgrounded): the executor keeps
      // running and the durable log lets a later reconnect replay the rest.
      req.signal.addEventListener('abort', finish)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
