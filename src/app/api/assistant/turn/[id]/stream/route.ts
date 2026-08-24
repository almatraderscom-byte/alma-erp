import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getTurnSnapshot } from '@/agent/lib/turn-status'
import {
  getReplayEvents,
  pollTurnEvents,
  sanitizeTurnEventPayloadForReferenceRollout,
  subscribeTurnEvents,
} from '@/agent/lib/turn-events'
import { runTurnTail } from '@/agent/lib/turn-stream-tailer'
import {
  negotiateProseProtocol,
  projectEventForProtocol,
  proseProtocolFromVersions,
  type WireEvent,
} from '@/agent/lib/presentation/prose-lifecycle'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Live stream of a durable turn (worker OR inline — both write the same event
 * log since roadmap Phase 3).
 *
 * Subscribes to the Redis channel FIRST, then replays `agent_turn_events` newer
 * than the client's cursor (`?afterSeq=` or the standard `Last-Event-ID` header —
 * frames carry `id: <seq>` so EventSource reconnects resume automatically), then
 * drains what arrived meanwhile and tails live. Emission is seq-deduped and a
 * sequence gap is healed from the durable log before the later event is applied
 * (reliability epic R-2, handoff F-08). Closes after a terminal event; replay is
 * page-capped with cursor continuation for pathological turns.
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

  // Prose lifecycle v2 mixed-version safety: the client says which prose family
  // it can reduce (`?proto=2`); the turn row says which family was stored. A v1
  // client attached to a v2 turn gets a deliberate read-time v1 projection —
  // the durable log itself keeps the typed family.
  const clientProtocol = negotiateProseProtocol({ requested: req.nextUrl.searchParams.get('proto') })

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      let keepAlive: ReturnType<typeof setInterval> | undefined

      const safeEnqueue = (frame: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          /* stream already closed */
        }
      }
      // `id:` carries the seq so EventSource's automatic Last-Event-ID resume works.
      let turnProtocol: 1 | 2 = 1
      const emitEvent = (seq: number, payload: unknown) => {
        const projected = turnProtocol === 2 && payload && typeof payload === 'object'
          ? projectEventForProtocol(payload as WireEvent, clientProtocol)
          : payload
        if (projected == null) return
        // Reference projections obey the CURRENT kill switch at the single
        // delivery boundary, after protocol projection (rows may have been
        // written while rendering was ON).
        const exposed = sanitizeTurnEventPayloadForReferenceRollout(projected)
        safeEnqueue(`id: ${seq}\ndata: ${JSON.stringify(exposed)}\n\n`)
      }

      // 0) Connection snapshot — lets the client reconcile turn state instantly
      //    (roadmap 3.5) without a separate status request.
      const snap = await getTurnSnapshot(turnId)
      if (!snap) {
        // Fail closed (Codex P1 #834 r6): without the snapshot the turn's prose
        // family is unknown — serving stored v2 rows as if v1 would put a
        // superseded draft beside its replacement. The client reconciles via
        // turn-status / polling and re-attaches.
        safeEnqueue(`data: ${JSON.stringify({ type: 'error', message: 'turn_snapshot_unavailable' })}\n\n`)
        closed = true
        try {
          controller.close()
        } catch {
          /* already closed */
        }
        return
      }
      {
        turnProtocol = proseProtocolFromVersions(snap.versions)
        safeEnqueue(`data: ${JSON.stringify({
          type: 'turn_snapshot',
          turnId: snap.id,
          conversationId: snap.conversationId,
          status: snap.status,
          lastSeq: snap.lastSeq,
          assistantMessageId: snap.assistantMessageId,
          // The family this turn's replay/tail is served in for THIS client.
          agentProseProtocol: Math.min(turnProtocol, clientProtocol),
        })}\n\n`)
      }

      // 1–3) Subscribe FIRST, replay, drain, then tail with gap healing — the
      //      orchestration lives in turn-stream-tailer.ts (unit-tested; F-08).
      const tail = runTurnTail(
        {
          getReplay: (after, limit) => getReplayEvents(turnId, after, limit, { throwOnError: true }),
          subscribe: (onEvent, signal) => subscribeTurnEvents(turnId, onEvent, { signal }),
          getStatus: async () => {
            const current = await getTurnSnapshot(turnId)
            return current
              ? {
                  turnId: current.id,
                  conversationId: current.conversationId,
                  status: current.status,
                  lastSeq: current.lastSeq,
                  assistantMessageId: current.assistantMessageId,
                  continuationNeeded: current.continuationNeeded,
                }
              : null
          },
          poll: (after, onEvent) => pollTurnEvents(turnId, after, onEvent),
          emit: (evt) => emitEvent(evt.seq, evt.payload),
          control: (payload) => safeEnqueue(`data: ${JSON.stringify(payload)}\n\n`),
          finish: () => {
            if (closed) return
            closed = true
            if (keepAlive) clearInterval(keepAlive)
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          },
          log: (event, detail) => console.warn(`[turn-stream] ${event}`, detail),
        },
        {
          turnId,
          afterSeq,
          snapshotLastSeq: snap?.lastSeq ?? null,
          snapshotStatus: snap?.status ?? null,
          snapshotConversationId: snap?.conversationId ?? null,
          snapshotAssistantMessageId: snap?.assistantMessageId ?? null,
          snapshotContinuationNeeded: snap?.continuationNeeded === true,
        },
      )
      await tail.ready
      if (closed) return

      // Keepalive so idle proxies don't drop the stream during long tool steps.
      keepAlive = setInterval(() => safeEnqueue(`: ping\n\n`), 10_000)

      // Abort if the client disconnects (app backgrounded): the executor keeps
      // running and the durable log lets a later reconnect replay the rest.
      req.signal.addEventListener('abort', () => { void tail.close() })
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
