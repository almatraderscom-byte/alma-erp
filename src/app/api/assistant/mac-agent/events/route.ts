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
import { authenticateDevice } from '@/agent/lib/mac-agent/bus'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_EVENTS_PER_POST = 80
const MAX_TEXT_CHARS = 4_000
const KINDS = new Set(['started', 'text', 'tool', 'sent', 'turn_done', 'error', 'ended'])

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

  // Which of these are genuinely NEW? A retried batch can mix an already-stored
  // notable event with one fresh non-notable row; `created.count > 0` alone
  // would then re-push the old notable (Codex round 3). Ask first, so the push
  // candidate set is exactly the rows this POST inserts.
  const known: Set<number> = await db.macAgentSessionEvent
    .findMany({
      where: { sessionId, seq: { in: rows.map((r) => r.seq) } },
      select: { seq: true },
    })
    .then((found: Array<{ seq: number }>) => new Set(found.map((f) => f.seq)))
    .catch(() => new Set<number>())
  const freshRows = rows.filter((r) => !known.has(r.seq))

  const created = await db.macAgentSessionEvent.createMany({
    data: rows,
    skipDuplicates: true, // (sessionId, seq) — a retried batch stores nothing twice
  })

  // Push when it matters: error, end, or a turn that ends in a question. Only
  // for rows actually stored this POST — a retried duplicate must not re-push.
  if (created.count > 0) {
    const notable = freshRows.find(
      (r) =>
        r.kind === 'error' ||
        r.kind === 'ended' ||
        (r.kind === 'turn_done' && (r.isError || /\?\s*$/.test(r.text ?? ''))),
    )
    if (notable) {
      try {
        const { pushNativeToOwner } = await import('@/agent/lib/native-owner-push')
        const title =
          notable.kind === 'error'
            ? 'সেশনে সমস্যা হয়েছে'
            : notable.kind === 'ended'
              ? 'সেশন শেষ হয়েছে'
              : notable.isError
                ? 'সেশনের টার্ন ব্যর্থ'
                : 'সেশন আপনার উত্তর চাইছে'
        await pushNativeToOwner({
          tier: 2,
          title,
          message: (notable.text ?? '').slice(0, 160) || 'বিস্তারিত দেখতে ট্যাপ করুন।',
          notificationKind: 'alert',
          actionUrl: '/agent',
          // One push per (session, seq) forever — the dedupe id, not a timer.
          deliveryId: `mac-session:${sessionId}:${notable.seq}`,
        })
      } catch {
        /* push is best-effort; the feed row is already stored */
      }
    }
  }

  return Response.json({ ok: true, stored: created.count })
}
