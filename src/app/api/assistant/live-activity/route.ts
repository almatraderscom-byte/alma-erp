/**
 * "What is the agent doing on my machines right now?" — one poll, every surface.
 *
 * The owner asked to watch the work from his phone the way Codex and the ChatGPT
 * app show it: small inside the chat, expandable when he wants a proper look.
 * That needs a single feed, because from his side there is no difference between
 * "it is running a command on the Mac" and "it is clicking in Chrome" — it is
 * all just the agent working.
 *
 * Read-only, owner-session only, and deliberately cheap: two indexed queries and
 * whatever the newest screenshot happens to be. It is polled while work is live,
 * so it must stay small.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Anything older than this is history, not "right now". */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const RECENT_STEPS = 12
/** A step this fresh still reads as "now" even though it has already finished. */
const JUST_FINISHED_MS = 25_000

export type ActivitySurface = 'mac' | 'session' | 'browser'

export interface ActivityStep {
  id: string
  surface: ActivitySurface
  /** One short Bangla line the owner reads at a glance. */
  labelBn: string
  /** The literal command / action, for the expanded view. */
  detail: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | string
  /** green = ran by itself, amber = he approved it. Mac only. */
  policy: string | null
  at: string
  /** L4: set on session-event steps so the dock can reply to that session. */
  sessionId?: string | null
  /** claude | codex — the docks offer replies only for claude (codex is one-shot). */
  sessionTool?: string | null
  /** The raw event kind (text/tool/turn_done/ended/…) — lets the docks tell a
   *  finished-for-good session (ended/error) from an idle-but-replyable one. */
  sessionKind?: string | null
}

function macLabel(action: string, command: string | null): string {
  if (action === 'run_command') return command ? `💻 ${command}` : '💻 কমান্ড চালাচ্ছে'
  if (action === 'screenshot') return '📸 স্ক্রিনশট নিচ্ছে'
  if (action === 'power') return '☕ Mac জাগিয়ে রাখছে'
  if (action === 'ping') return '📡 Mac-এর সাথে কথা বলছে'
  if (action === 'session_open') return '🧠 Claude সেশন খুলছে'
  if (action === 'session_send') return '📨 সেশনে কাজ পাঠাচ্ছে'
  if (action === 'session_read') return '👀 সেশনের অগ্রগতি দেখছে'
  if (action === 'session_stop') return '⏹️ সেশন বন্ধ করছে'
  if (action === 'session_list') return '📋 চলমান সেশন দেখছে'
  return `💻 ${action}`
}

const BROWSER_LABEL: Record<string, string> = {
  navigate: '🌐 পেজ খুলছে',
  read_text: '📖 পড়ছে',
  read_dom: '👀 দেখছে',
  click: '🖱️ ক্লিক করছে',
  type: '⌨️ লিখছে',
  press: '⏎ কী চাপছে',
  select_option: '🔽 অপশন বাছছে',
  hover: '🫳 হোভার',
  scroll: '↕️ স্ক্রল করছে',
  screenshot: '📸 স্ক্রিনশট',
  go_back: '↩️ পিছনে যাচ্ছে',
  switch_tab: '🗂️ ট্যাব বদলাচ্ছে',
  wait: '⏳ অপেক্ষা করছে',
}

function normalizeStatus(raw: string): ActivityStep['status'] {
  if (raw === 'delivered') return 'running'
  if (raw === 'cancelled') return 'failed'
  return raw
}

/**
 * L4: a session EVENT (the session's own words) → one feed step. The dock
 * renders these with the same row shape as command steps, so both docks gained
 * the transcript without a render change.
 */
function sessionEventStep(r: {
  id: string
  sessionId: string
  tool?: string
  kind: string
  text: string | null
  isError: boolean
  at: Date
}): ActivityStep {
  const snippet = (r.text ?? '').replace(/\s+/g, ' ').trim()
  const short = snippet.length > 90 ? `${snippet.slice(0, 90)}…` : snippet
  let labelBn: string
  let status: ActivityStep['status']
  switch (r.kind) {
    case 'started':
      labelBn = '🧠 সেশন শুরু হলো'
      status = 'running'
      break
    case 'text':
      labelBn = short ? `🧠 ${short}` : '🧠 ভাবছে'
      status = 'running'
      break
    case 'tool':
      labelBn = short ? `🔧 ${short}` : '🔧 টুল চালাচ্ছে'
      status = 'running'
      break
    case 'sent':
      labelBn = '📨 নির্দেশ পাঠানো হলো'
      status = 'running'
      break
    case 'turn_done':
      labelBn = r.isError ? '⚠️ টার্ন ব্যর্থ হলো' : short ? `✅ ${short}` : '✅ টার্ন শেষ'
      status = r.isError ? 'failed' : 'done'
      break
    case 'error':
      labelBn = '⚠️ সেশনে সমস্যা'
      status = 'failed'
      break
    case 'ended':
      labelBn = '⏹️ সেশন শেষ'
      status = 'done'
      break
    case 'resumed':
      labelBn = '🔄 সেশন আবার জোড়া লাগল'
      status = 'running'
      break
    case 'detached':
      labelBn = '⏸️ সেশন অপেক্ষায় (daemon restart)'
      status = 'done'
      break
    default:
      labelBn = `🧠 ${r.kind}`
      status = 'done'
  }
  // A session's text/tool events are instants, not open-ended work: left as
  // "running" they would keep the dock lit for the whole 10-minute window after
  // the session went quiet. Only a FRESH one counts as happening now.
  if (status === 'running' && Date.now() - r.at.getTime() > 60_000) status = 'done'
  return {
    id: `se:${r.id}`,
    surface: 'session',
    labelBn,
    detail: snippet || null,
    status,
    policy: null,
    at: r.at.toISOString(),
    sessionId: r.sessionId,
    sessionTool: r.tool ?? 'claude',
    sessionKind: r.kind,
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const since = new Date(Date.now() - ACTIVE_WINDOW_MS)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const [macRows, browserRows, sessionEventRows, sessionNewestRows, sessionCostRows, sessionErrRows, sessionOkRows, frameMeta] =
    await Promise.all([
    db.macAgentCommand
      .findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_STEPS,
        select: {
          id: true, action: true, params: true, status: true,
          policyLevel: true, createdAt: true, stdout: true,
        },
      })
      .catch(() => []),
    db.liveBrowserCommand
      .findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_STEPS,
        // `result` carries the screenshot data URI and is large; only the
        // screenshot rows need it, so the rest of the poll stays small on a
        // phone (Codex review).
        select: { id: true, action: true, params: true, status: true, createdAt: true },
      })
      .catch(() => []),
    db.macAgentSessionEvent
      .findMany({
        where: { createdAt: { gte: since } },
        orderBy: { at: 'desc' },
        take: RECENT_STEPS,
        select: { id: true, sessionId: true, tool: true, kind: true, text: true, isError: true, costUsd: true, at: true },
      })
      .catch(() => []),
    // L5 session cards: the newest event PER SESSION (Prisma distinct picks
    // the first row per group under the orderBy), regardless of how many
    // events the window holds — no cap to fall off (Codex, L5 round 2).
    db.macAgentSessionEvent
      .findMany({
        where: { createdAt: { gte: since } },
        orderBy: { at: 'desc' },
        distinct: ['sessionId'],
        select: { sessionId: true, tool: true, kind: true, text: true, isError: true, at: true },
      })
      .catch(() => []),
    // Whole-window cost per session — a database SUM, not a capped scan.
    db.macAgentSessionEvent
      .groupBy({
        by: ['sessionId'],
        where: { createdAt: { gte: since } },
        _sum: { costUsd: true },
      })
      .catch(() => []),
    // Newest failure per session (error, or an errored turn) — for the
    // "ended after an unresolved error is still a failure" rule.
    db.macAgentSessionEvent
      .groupBy({
        by: ['sessionId'],
        where: {
          createdAt: { gte: since },
          OR: [{ kind: 'error' }, { kind: 'turn_done', isError: true }],
        },
        _max: { at: true },
      })
      .catch(() => []),
    // Newest successful turn per session.
    db.macAgentSessionEvent
      .groupBy({
        by: ['sessionId'],
        where: { createdAt: { gte: since }, kind: 'turn_done', isError: false },
        _max: { at: true },
      })
      .catch(() => []),
    // L7 — the newest live-stream frame's TIMESTAMP only; the payload is
    // fetched below only when it beats what the client already holds.
    db.macAgentFrame
      .findFirst({
        where: { at: { gte: since } },
        orderBy: { at: 'desc' },
        select: { deviceId: true, at: true },
      })
      .catch(() => null),
  ])

  const steps: ActivityStep[] = []
  /** Newest wins across BOTH surfaces — not whichever list we happened to read first. */
  let screenshot: string | null = null
  let screenshotAt: string | null = null
  const considerShot = (dataUri: string | null | undefined, at: Date) => {
    if (!dataUri?.startsWith('data:image')) return
    const iso = at.toISOString()
    if (!screenshotAt || iso > screenshotAt) {
      screenshot = dataUri
      screenshotAt = iso
    }
  }

  for (const r of macRows as Array<Record<string, unknown>>) {
    const params = (r.params as Record<string, unknown> | null) ?? {}
    const command = typeof params.command === 'string' ? params.command : null
    const action = String(r.action)
    steps.push({
      id: String(r.id),
      surface: action.startsWith('session_') ? 'session' : 'mac',
      labelBn: macLabel(action, command),
      detail: command,
      status: normalizeStatus(String(r.status)),
      policy: (r.policyLevel as string) ?? null,
      at: (r.createdAt as Date).toISOString(),
    })
    // The Mac screenshot verb stores its data URI in stdout.
    if (action === 'screenshot' && typeof r.stdout === 'string') {
      considerShot(r.stdout, r.createdAt as Date)
    }
  }

  for (const r of browserRows as Array<Record<string, unknown>>) {
    const params = (r.params as Record<string, unknown> | null) ?? {}
    const target = [params.url, params.selector, params.text].find((v) => typeof v === 'string' && v) as string | undefined
    const action = String(r.action)
    steps.push({
      id: String(r.id),
      surface: 'browser',
      labelBn: BROWSER_LABEL[action] ?? `🌐 ${action}`,
      detail: target ?? null,
      status: normalizeStatus(String(r.status)),
      policy: null,
      at: (r.createdAt as Date).toISOString(),
    })
  }

  // The client sends the `screenshotAt` it already holds; an unchanged frame is
  // answered with metadata only. Without this, every 3-second active poll
  // re-downloaded the same up-to-3MB base64 payload — ~60 MB a minute on a
  // phone showing one static screenshot (Codex P1).
  const screenshotAfter = req.nextUrl.searchParams.get('screenshotAfter')

  // Fetch the screenshot payload ONLY for the browser rows that carry one, and
  // only when it could be newer than what the client already has.
  const shotRow = (browserRows as Array<Record<string, unknown>>).find(
    (r) =>
      r.action === 'screenshot' &&
      (!screenshotAfter || (r.createdAt as Date).toISOString() > screenshotAfter),
  )
  if (shotRow) {
    const full = await db.liveBrowserCommand
      .findUnique({ where: { id: shotRow.id as string }, select: { result: true, createdAt: true } })
      .catch(() => null)
    const result = (full?.result as Record<string, unknown> | null) ?? null
    if (result && typeof result.screenshot === 'string') {
      considerShot(result.screenshot, full!.createdAt as Date)
    }
  }

  interface SessionEventRow {
    id: string
    sessionId: string
    tool: string
    kind: string
    text: string | null
    isError: boolean
    costUsd: number | null
    at: Date
  }
  // A completion supersedes the instantaneous events before it: a session whose
  // newest event is turn_done/ended must not keep showing an older text event
  // as "now running" for the rest of its 60s freshness (Codex round 3).
  const terminalAtBySession = new Map<string, number>()
  for (const r of sessionEventRows as SessionEventRow[]) {
    if (r.kind === 'turn_done' || r.kind === 'ended' || r.kind === 'error') {
      const t = r.at.getTime()
      if ((terminalAtBySession.get(r.sessionId) ?? 0) < t) terminalAtBySession.set(r.sessionId, t)
    }
  }
  const supersededStep = (r: SessionEventRow): ActivityStep => {
    const step = sessionEventStep(r)
    const terminalAt = terminalAtBySession.get(r.sessionId) ?? 0
    if (step.status === 'running' && terminalAt >= r.at.getTime()) step.status = 'done'
    return step
  }
  for (const r of sessionEventRows as SessionEventRow[]) {
    steps.push(supersededStep(r))
  }

  // L5 — one card per session: status from the raw lifecycle (a tool running
  // silently past 60s is still WORKING; a restored-but-detached session is
  // not), cost as a whole-window database SUM. An error no successful turn
  // followed marks the session failed even if `ended` came after it.
  const costBySession = new Map<string, number>(
    (sessionCostRows as Array<{ sessionId: string; _sum: { costUsd: number | null } }>).map((r) => [
      r.sessionId,
      r._sum.costUsd ?? 0,
    ]),
  )
  const errAtBySession = new Map<string, number>(
    (sessionErrRows as Array<{ sessionId: string; _max: { at: Date | null } }>).map((r) => [
      r.sessionId,
      r._max.at?.getTime() ?? 0,
    ]),
  )
  const okAtBySession = new Map<string, number>(
    (sessionOkRows as Array<{ sessionId: string; _max: { at: Date | null } }>).map((r) => [
      r.sessionId,
      r._max.at?.getTime() ?? 0,
    ]),
  )
  const sessions = (sessionNewestRows as SessionEventRow[]).map((r) => {
    let status: string
    switch (r.kind) {
      case 'ended':
        status =
          (errAtBySession.get(r.sessionId) ?? 0) > (okAtBySession.get(r.sessionId) ?? 0)
            ? 'failed'
            : 'done'
        break
      case 'error':
        status = 'failed'
        break
      case 'turn_done':
        status = r.isError ? 'failed' : 'done'
        break
      case 'detached':
        // Alive but waiting for a send to resume — a live pulse would lie.
        status = 'done'
        break
      default:
        status = 'working'
    }
    return {
      sessionId: r.sessionId,
      tool: r.tool,
      lastBn: sessionEventStep({ ...r, id: 'agg' }).labelBn,
      status,
      costUsd: Number((costBySession.get(r.sessionId) ?? 0).toFixed(4)),
      at: r.at.toISOString(),
    }
  })

  steps.sort((a, b) => b.at.localeCompare(a.at))
  const trimmed = steps.slice(0, RECENT_STEPS)
  const running = trimmed.filter((s) => s.status === 'running' || s.status === 'queued')

  // A read-only command finishes in about two seconds, and the dock polls every
  // three — so on the owner's most common request it would have found nothing
  // running and never shown itself at all. Anything that FINISHED in the last
  // few seconds still counts as "happening now" for display purposes; that is
  // what makes a fast command visible instead of silent.
  const justFinishedCutoff = new Date(Date.now() - JUST_FINISHED_MS).toISOString()
  const justFinished = trimmed.filter((s) => s.at > justFinishedCutoff)

  // L7 — a live-stream frame rides the same screenshot channel; the payload
  // is fetched only when it is genuinely newer than what the client holds.
  const frameMetaRow = frameMeta as { deviceId: string; at: Date } | null
  if (frameMetaRow) {
    const iso = frameMetaRow.at.toISOString()
    const clientHasIt = Boolean(screenshotAfter && iso <= screenshotAfter)
    const beatsCurrent = !screenshotAt || iso > (screenshotAt as string)
    if (beatsCurrent && !clientHasIt) {
      const full = await db.macAgentFrame
        .findUnique({ where: { deviceId: frameMetaRow.deviceId }, select: { dataUri: true, at: true } })
        .catch(() => null)
      if (full?.dataUri) considerShot(full.dataUri, full.at as Date)
    } else if (beatsCurrent) {
      // Client already holds this frame — advance the timestamp only.
      screenshotAt = iso
    }
  }

  // The timestamp must survive even when the payload is withheld: clearing it
  // made the client think there was no screenshot at all, drop its cache, and
  // re-download the full frame on the next poll — an every-other-poll oscillation
  // (Codex round 3). Any browser screenshot row in the window contributes its
  // timestamp, whether or not its payload was fetched above.
  const newestBrowserShot = (browserRows as Array<Record<string, unknown>>).find(
    (r) => r.action === 'screenshot',
  )
  if (newestBrowserShot) {
    const iso = (newestBrowserShot.createdAt as Date).toISOString()
    if (!screenshotAt || iso > (screenshotAt as string)) screenshotAt = iso
  }

  // Unchanged frame → metadata only; the client keeps the copy it has.
  // (cast: TS narrows screenshotAt to its `null` initializer here because the
  // assignments happen inside the considerShot closure)
  const heldAt = screenshotAt as string | null
  if (screenshotAfter && heldAt && heldAt <= screenshotAfter) {
    screenshot = null
  }

  return Response.json(
    {
      // The dock shows itself only while something is genuinely in flight — the
      // owner should never have a player sitting on his chat doing nothing. A
      // live stream IS work in flight: a frame fresher than ~10s keeps the
      // dock up and the poll fast even when no command row moved.
      active:
        running.length > 0 ||
        justFinished.length > 0 ||
        Boolean(frameMetaRow && Date.now() - frameMetaRow.at.getTime() < 10_000),
      /** L7 — server truth for the docks' stream toggle: a client that
       *  remounts mid-stream must show STOP, not a second start. */
      streaming: Boolean(frameMetaRow && Date.now() - frameMetaRow.at.getTime() < 10_000),
      current: running[0] ?? justFinished[0] ?? trimmed[0] ?? null,
      steps: trimmed,
      /** L5: per-session status + cost for the expanded view. */
      sessions,
      screenshot,
      screenshotAt,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
