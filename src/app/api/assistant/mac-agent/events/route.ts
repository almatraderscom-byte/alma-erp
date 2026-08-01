/**
 * L4 — the daemon streams what a CLI session is SAYING.
 *
 * The dock used to report only command rows: "a session exists". The session
 * driver on the Mac already buffers every assistant turn (text / tool /
 * turn_done, sequence-numbered); this endpoint receives those batches so the
 * owner can watch the session's own words from his phone.
 *
 * Same auth shape as /result: daemon bearer token, verified per-request with a
 * constant-time hash compare (and this path must stay listed in middleware.ts,
 * or auth never runs and every push 401s — the trap that broke pairing once).
 *
 * The (sessionId, seq) unique key makes retries idempotent: a daemon that
 * re-POSTs after a dropped response cannot duplicate the feed.
 *
 * This is ALSO where "push when it matters" lives (roadmap L4): a session that
 * errors, ends, or asks a question reaches the owner's phone via the existing
 * native push channel — because this is the single point every session event
 * flows through.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { authenticateDevice, isMacAgentEnabled } from '@/agent/lib/mac-agent/bus'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_EVENTS_PER_POST = 80
const MAX_TEXT_CHARS = 4_000
const KINDS = new Set([
  'started', 'text', 'tool', 'sent', 'turn_done', 'error', 'ended', 'resumed', 'detached',
])

function bearer(req: NextRequest): string {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

interface WireEvent {
  seq?: number
  at?: string
  kind?: string
  text?: string
  tool?: string
  result?: string
  isError?: boolean
  costUsd?: number
  error?: string
  messageBn?: string
}

interface EventsBody {
  sessionId?: string
  tool?: string
  events?: WireEvent[]
}

/** The one line of the event worth keeping, whichever field the kind carries. */
function eventText(e: WireEvent): string | null {
  const raw = e.text ?? e.result ?? e.tool ?? e.messageBn ?? e.error ?? null
  if (typeof raw !== 'string' || !raw.trim()) return null
  return raw.slice(0, MAX_TEXT_CHARS)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  // Server-side backstop for the owner's kill-switch: with Mac control OFF,
  // nothing gets ingested even if a daemon keeps trying (Codex round 7). The
  // daemon also stops on its own via the poll's `paused` flag.
  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_agent_disabled' }, { status: 409 })
  }

  const device = await authenticateDevice(bearer(req))
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: EventsBody
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const sessionId = String(body.sessionId ?? '').trim()
  if (!sessionId) return Response.json({ error: 'sessionId_required' }, { status: 400 })
  const tool = body.tool === 'codex' ? 'codex' : 'claude'

  const events = (Array.isArray(body.events) ? body.events : [])
    .filter((e) => Number.isFinite(Number(e.seq)) && KINDS.has(String(e.kind)))
    .slice(0, MAX_EVENTS_PER_POST)

  if (events.length === 0) return Response.json({ ok: true, stored: 0 })

  const rows = events.map((e) => ({
    deviceId: device.id,
    sessionId,
    tool,
    seq: Number(e.seq),
    kind: String(e.kind),
    text: eventText(e),
    isError: Boolean(e.isError) || e.kind === 'error',
    costUsd: typeof e.costUsd === 'number' ? e.costUsd : null,
    at: e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at) : new Date(),
  }))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const created = await db.macAgentSessionEvent.createMany({
    data: rows,
    skipDuplicates: true, // (sessionId, seq) — a retried batch stores nothing twice
  })

  // Push when it matters — through a DURABLE ledger on the rows themselves.
  // The sweep below picks up every stored-but-unpushed notable event (this
  // batch's or an earlier one whose OneSignal call failed transiently), so a
  // dropped push retries on the next event POST instead of being lost forever
  // (the P2 deferred from the L4 review). pushedAt set = settled (delivered
  // or deliberately skipped); attempts cap at 3 so a permanently broken
  // notification can't retry into eternity.
  await sweepUnpushedNotables(db, sessionId)

  return Response.json({ ok: true, stored: created.count })
}

function isQuestion(text: string | null): boolean {
  return /\?\s*$/.test(text ?? '')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sweepUnpushedNotables(db: any, sessionId: string) {
  try {
    const candidates: Array<{
      id: string
      seq: number
      kind: string
      text: string | null
      isError: boolean
      pushAttempts: number
    }> = await db.macAgentSessionEvent.findMany({
      where: {
        sessionId,
        pushedAt: null,
        pushAttempts: { lt: 3 },
        OR: [{ kind: 'error' }, { kind: 'ended' }, { kind: 'turn_done' }],
      },
      orderBy: { seq: 'desc' },
      // Wider than the batch cap (80): even an all-turn_done maximum batch
      // cannot bury an older owed question below the sweep (Codex, L7 round 3).
      take: 100,
      select: { id: true, seq: true, kind: true, text: true, isError: true, pushAttempts: true },
    })
    if (candidates.length === 0) return

    // Push ONLY when the newest terminal row is itself notable. An owed
    // question that a newer quiet turn_done has superseded settles silently —
    // the session moved past it, and pushing it late would mislead (Codex,
    // L7 round 4).
    const newest = candidates[0]
    const newestIsNotable =
      newest.kind === 'error' || newest.kind === 'ended' || newest.isError || isQuestion(newest.text)
    const settleSilently = candidates.filter((c) => !(newestIsNotable && c.id === newest.id))
    if (settleSilently.length > 0) {
      await db.macAgentSessionEvent.updateMany({
        where: { id: { in: settleSilently.map((c) => c.id) } },
        data: { pushedAt: new Date() },
      })
    }
    if (!newestIsNotable) return
    const notable = newest

    const { pushNativeToOwner } = await import('@/agent/lib/native-owner-push')
    const title =
      notable.kind === 'error'
        ? 'সেশনে সমস্যা হয়েছে'
        : notable.kind === 'ended'
          ? 'সেশন শেষ হয়েছে'
          : notable.isError
            ? 'সেশনের টার্ন ব্যর্থ'
            : 'সেশন আপনার উত্তর চাইছে'
    const result = await pushNativeToOwner({
      tier: 2,
      title,
      message: (notable.text ?? '').slice(0, 160) || 'বিস্তারিত দেখতে ট্যাপ করুন।',
      notificationKind: 'alert',
      actionUrl: '/agent',
      // One push per (session, seq) forever — the dedupe id, not a timer.
      deliveryId: `mac-session:${sessionId}:${notable.seq}`,
    })
    // Settled: delivered, OR a clean no-op (push disabled / unconfigured /
    // filtered by preference) that a retry would repeat identically. Only a
    // genuine transport failure stays owed.
    const settled = result.ok || !result.attempted
    await db.macAgentSessionEvent.update({
      where: { id: notable.id },
      data: settled
        ? { pushedAt: new Date() }
        : { pushAttempts: { increment: 1 } },
    })
  } catch {
    /* push is best-effort per request; the ledger keeps it owed for next time */
  }
}
