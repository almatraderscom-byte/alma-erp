/**
 * "What is the agent doing on my machines right now?" — one poll, every surface.
 *
 * The owner asked to watch the work from his phone the way Codex and the ChatGPT
 * app show it: small inside the chat, expandable when he wants a proper look.
 * One feed carries independent Browser and Mac preview cards so the UI can keep
 * both visible as a Codex-style stack instead of whichever frame won a race.
 *
 * Read-only, owner-session only, and deliberately cheap: two indexed queries and
 * whatever the newest screenshot happens to be. It is polled while work is live,
 * so it must stay small.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveOwnerUserIds } from '@/agent/lib/native-owner-push'
import { getJwt } from '@/lib/api-guards'
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
  /** Browser card identity when more than one paired Chrome is active. */
  contextId?: string | null
}

export interface ActivityPreview {
  surface: 'mac' | 'browser'
  /** Stable card/cache identity; optional for rolling compatibility. */
  contextId?: string | null
  screenshot: string | null
  screenshotAt: string | null
  labelBn: string
  active: boolean
  /** A true Agora stream replaces the Mac fallback frame in native clients. */
  videoDeviceId?: string | null
  /** Additive activity/frame identity for turn-bound native docks. */
  turnId?: string | null
  conversationId?: string | null
  activityId?: string | null
  sourceState?: 'starting' | 'live' | 'between_steps' | 'done' | 'failed'
  activityAt?: string | null
  frameAt?: string | null
  frameSeq?: number | null
  autoStreamOwned?: boolean
}

export function browserPreviewId(deviceId: string, tabContextId?: string | null): string {
  return tabContextId ? `browser:${deviceId}:${tabContextId}` : `browser:${deviceId}`
}

function boundedActivityId(value: string | null): string | null {
  const id = value?.trim() ?? ''
  return id.length > 0 && id.length <= 200 ? id : null
}

export function activityCommandBinding(
  turnId: string | null,
  conversationId: string | null,
): Record<string, string | null> {
  // An unscoped legacy client may see only rows produced by legacy/manual
  // callers. Omitting this predicate used to expose every bound task to it.
  return turnId && conversationId
    ? { turnId, conversationId }
    : { turnId: null, conversationId: null }
}

/** Parse the bounded per-card conditional-frame map sent by the new docks. */
export function parsePreviewAfter(raw: string | null): Record<string, string> {
  if (!raw || raw.length > 10_000) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([key, value]) => key.length <= 200 && typeof value === 'string' && value.length <= 80)
        .slice(0, 24) as Array<[string, string]>,
    )
  } catch {
    return {}
  }
}

export function isResolvedLiveActivityOwner(subjectId: string, ownerIds: string[]): boolean {
  return ownerIds.includes(subjectId)
}

export function heldPreviewAt(
  previewAfter: Record<string, string>,
  hasPreviewAfter: boolean,
  contextId: string,
  rollingFallback: string | null,
): string | null {
  // Once a client sends a per-card map, a missing key means that card has
  // never been cached. Falling back to another Chrome's rolling timestamp can
  // suppress the new card forever when its first frame is older.
  return hasPreviewAfter ? (previewAfter[contextId] ?? null) : rollingFallback
}

export interface BrowserActivityRow {
  id: string
  deviceId: string
  device?: { name?: string | null } | null
  action: string
  params: unknown
  status: string
  createdAt: Date
  resolvedAt?: Date | null
  turnId?: string | null
  conversationId?: string | null
  contextId?: string | null
}

interface BrowserFrameMetaRow {
  deviceId: string
  contextId: string
  capturedAt: Date
  sequence: number
  turnId: string
  conversationId: string
}

interface MacFrameMetaRow {
  deviceId: string
  at: Date
  sequence: number
  turnId: string | null
  conversationId: string | null
}

export function sameMacFrameActivity(
  frame: Pick<MacFrameMetaRow, 'turnId' | 'conversationId'>,
  turnId: string | null,
  conversationId: string | null,
): boolean {
  return !turnId || !conversationId
    ? frame.turnId === null && frame.conversationId === null
    : frame.turnId === turnId && frame.conversationId === conversationId
}

export function macVideoStampIsActive(
  value: string | null,
  turnId: string | null,
  conversationId: string | null,
  now = Date.now(),
): boolean {
  if (!value) return false
  let at = value
  let stampTurnId: string | null = null
  let stampConversationId: string | null = null
  try {
    const parsed = JSON.parse(value) as {
      at?: unknown
      turnId?: unknown
      conversationId?: unknown
    }
    if (typeof parsed.at !== 'string') return false
    at = parsed.at
    stampTurnId = typeof parsed.turnId === 'string' ? parsed.turnId : null
    stampConversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId : null
  } catch {
    // Legacy stamps were plain ISO strings and are safe only for unscoped feeds.
  }
  if (!Number.isFinite(Date.parse(at)) || now - Date.parse(at) >= 10_000) return false
  return turnId && conversationId
    ? stampTurnId === turnId && stampConversationId === conversationId
    : stampTurnId === null && stampConversationId === null
}

export function activityAllowsVideoIdentity(
  boundRequested: boolean,
  turnStatus: string | null,
): boolean {
  return !boundRequested || turnStatus === 'running'
}

export function effectiveBrowserTabContext(
  commandContextId: string | null | undefined,
  newestFrameContextId: string | null | undefined,
): string | null {
  return commandContextId?.trim() || newestFrameContextId?.trim() || null
}

interface BrowserDeviceActivity {
  id: string
  name?: string | null
  commands?: Array<Omit<BrowserActivityRow, 'deviceId' | 'device'>>
}

/** The database caps commands inside each device relation, never globally. */
export function flattenBrowserDeviceRows(devices: BrowserDeviceActivity[]): BrowserActivityRow[] {
  return devices.flatMap((device) => (device.commands ?? []).map((command) => ({
    ...command,
    deviceId: device.id,
    device: { name: device.name ?? null },
  })))
}

export interface MacPreviewState {
  deviceId: string
  screenshot: string | null
  screenshotAt: string | null
  labelBn: string
  active: boolean
  videoActive: boolean
  turnId?: string | null
  conversationId?: string | null
  activityId?: string | null
  sourceState?: ActivityPreview['sourceState']
  activityAt?: string | null
  frameSeq?: number | null
  autoStreamOwned?: boolean
}

/**
 * Keep every Mac's pixels and RTC identity in the same tuple. A newer command
 * screenshot from Mac A must never inherit Mac B's broadcaster id.
 */
export function projectMacPreviews(states: MacPreviewState[]): ActivityPreview[] {
  return states
    .filter((state) => state.active || state.videoActive || Boolean(state.screenshotAt))
    .map((state) => ({
      surface: 'mac',
      contextId: `mac:${state.deviceId}`,
      screenshot: state.screenshot,
      screenshotAt: state.screenshotAt,
      labelBn: state.labelBn,
      active: state.active || state.videoActive,
      videoDeviceId: state.videoActive ? state.deviceId : null,
      turnId: state.turnId,
      conversationId: state.conversationId,
      activityId: state.activityId,
      sourceState: state.sourceState,
      activityAt: state.activityAt,
      frameAt: state.screenshotAt,
      frameSeq: state.frameSeq,
      autoStreamOwned: state.autoStreamOwned,
    }))
}

export function boundPreviewSourceState(input: {
  turnStatus: string | null
  hasSource: boolean
  hasFreshFrame: boolean
}): ActivityPreview['sourceState'] {
  if (input.turnStatus === 'error' || input.turnStatus === 'canceled') return 'failed'
  if (input.turnStatus && input.turnStatus !== 'running') return 'done'
  if (input.hasFreshFrame) return 'live'
  if (input.hasSource) return 'between_steps'
  return 'starting'
}

export function singleMacPreviewVideoDeviceId(previews: ActivityPreview[]): string | null {
  const macPreviews = previews.filter((preview) => preview.surface === 'mac')
  return macPreviews.length === 1 ? (macPreviews[0].videoDeviceId ?? null) : null
}

export function activityFeedIsActive(input: {
  runningCount: number
  justFinishedCount: number
  previews: ActivityPreview[]
  freshMacFrameCount: number
}): boolean {
  return input.runningCount > 0
    || input.justFinishedCount > 0
    || input.freshMacFrameCount > 0
    || input.previews.some((preview) => preview.active)
}

interface MacActivityRow {
  id: string
  deviceId: string
  action: string
  params: unknown
  status: string
  policyLevel: string | null
  createdAt: Date
  resolvedAt?: Date | null
  turnId?: string | null
  conversationId?: string | null
}

function commandActivityAt(row: { createdAt: Date; resolvedAt?: Date | null }): Date {
  return row.resolvedAt ?? row.createdAt
}

interface MacDeviceActivity {
  id: string
  name?: string | null
  commands?: Array<Omit<MacActivityRow, 'deviceId'>>
}

function flattenMacDeviceRows(devices: MacDeviceActivity[]): MacActivityRow[] {
  return devices.flatMap((device) => (device.commands ?? []).map((command) => ({
    ...command,
    deviceId: device.id,
  })))
}

function macLabel(action: string, command: string | null): string {
  if (action === 'run_command') return command ? `💻 ${command}` : '💻 কমান্ড চালাচ্ছে'
  if (action === 'screenshot') return '📸 স্ক্রিনশট নিচ্ছে'
  if (action === 'ui_screenshot') return '📸 App proof screenshot নিচ্ছে'
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

  const owner = await getJwt(req)
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // SUPER_ADMIN is a role, not device ownership. Only the explicitly resolved
  // founder/owner may read screen frames and session text; a second admin must
  // never inherit access merely because their role string matches.
  const resolvedOwnerIds = await resolveOwnerUserIds()
  if (!isResolvedLiveActivityOwner(owner.sub, resolvedOwnerIds)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const since = new Date(Date.now() - ACTIVE_WINDOW_MS)
  const db = prisma as any
  const requestedTurnId = boundedActivityId(req.nextUrl.searchParams.get('turnId'))
  const requestedConversationId = boundedActivityId(req.nextUrl.searchParams.get('conversationId'))
  if (Boolean(requestedTurnId) !== Boolean(requestedConversationId)) {
    return Response.json({ error: 'turnId_and_conversationId_required_together' }, { status: 400 })
  }
  const boundRequested = Boolean(requestedTurnId && requestedConversationId)
  const boundTurn: { id: string; conversationId: string; status: string; startedAt: Date; finishedAt: Date | null } | null =
    boundRequested
      ? await db.agentTurn.findFirst({
          where: { id: requestedTurnId, conversationId: requestedConversationId },
          select: { id: true, conversationId: true, status: true, startedAt: true, finishedAt: true },
        }).catch(() => null)
      : null
  // Even a missing/terminal requested turn stays scoped to its exact ids; never
  // fall back to owner-global history and show pixels from another task.
  const commandBinding = activityCommandBinding(requestedTurnId, requestedConversationId)

  // Parse conditional-frame state before the queries so every surface uses the
  // same per-card cache semantics.
  const screenshotAfter = req.nextUrl.searchParams.get('screenshotAfter')
  const wantsPreviewDeck = req.nextUrl.searchParams.get('previewDeck') === '1'
  const browserScreenshotAfter = wantsPreviewDeck
    ? req.nextUrl.searchParams.get('browserScreenshotAfter')
    : screenshotAfter
  const macScreenshotAfter = wantsPreviewDeck
    ? req.nextUrl.searchParams.get('macScreenshotAfter')
    : screenshotAfter
  const hasPreviewAfter = wantsPreviewDeck && req.nextUrl.searchParams.has('previewAfter')
  const previewAfter = hasPreviewAfter
    ? parsePreviewAfter(req.nextUrl.searchParams.get('previewAfter'))
    : {}

  // Resolve the owner's device boundary first. Session/frame tables carry a
  // deviceId but no Prisma relation, so this list is the scope for every query.
  const [macDevices, browserDevices] = await Promise.all([
    db.macAgentDevice
      .findMany({
        where: { ownerUserId: owner.sub, revoked: false },
        select: {
          id: true,
          name: true,
          commands: {
            where: { createdAt: { gte: since }, ...commandBinding },
            orderBy: { createdAt: 'desc' },
            take: RECENT_STEPS,
            select: {
              id: true, action: true, params: true, status: true,
              policyLevel: true, createdAt: true, resolvedAt: true,
              turnId: true, conversationId: true,
            },
          },
        },
      })
      .catch(() => []),
    db.liveBrowserDevice
      .findMany({
        where: { ownerUserId: owner.sub, revoked: false, pairedAt: { not: null } },
        select: {
          id: true,
          name: true,
          commands: {
            where: { createdAt: { gte: since }, ...commandBinding },
            orderBy: { createdAt: 'desc' },
            take: RECENT_STEPS,
            select: {
              id: true, action: true, params: true, status: true, createdAt: true,
              resolvedAt: true, turnId: true, conversationId: true, contextId: true,
            },
          },
        },
      })
      .catch(() => []),
  ])
  const typedMacDevices = macDevices as MacDeviceActivity[]
  const macDeviceIds = typedMacDevices.map((device) => device.id)
  const boundMacDeviceIds = boundRequested
    ? typedMacDevices.filter((device) => (device.commands?.length ?? 0) > 0).map((device) => device.id)
    : macDeviceIds
  const macDeviceNameById = new Map(
    typedMacDevices.map((device) => [device.id, device.name ?? null]),
  )
  const typedBrowserDevices = browserDevices as BrowserDeviceActivity[]
  const browserDeviceIds = typedBrowserDevices.map((device) => device.id)
  const browserDeviceNameById = new Map(
    typedBrowserDevices.map((device) => [device.id, device.name ?? null]),
  )
  const sessionDeviceIds = boundRequested ? [] : macDeviceIds

  // Retry driver for owed session notifications: a session waiting on the
  // owner's answer (or already ended) may never emit another event, so the
  // events POST alone cannot retry its failed push — this regular owner poll
  // can (throttled inside; fire-and-forget so the dock stays fast).
  void import('@/agent/lib/mac-agent/session-push')
    .then((m) => m.sweepOwedSessionPushes(db))
    .catch(() => {})
  const [macShotMetaRows, browserShotMetaRows, sessionEventRows, sessionNewestRows, sessionCostRows, sessionErrRows, sessionOkRows, frameMetas, browserFrameMetas] =
    await Promise.all([
    // Preserve one screenshot source per Mac even when a busy device produced
    // more than RECENT_STEPS newer non-screenshot commands.
    db.macAgentCommand
      .findMany({
        where: {
          deviceId: { in: macDeviceIds },
          action: { in: ['screenshot', 'ui_screenshot'] },
          createdAt: { gte: since },
          ...commandBinding,
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['deviceId'],
        select: {
          id: true, deviceId: true, action: true, params: true, status: true,
          policyLevel: true, createdAt: true, resolvedAt: true,
          turnId: true, conversationId: true,
        },
      })
      .catch(() => []),
    // Keep the newest screenshot metadata for EVERY paired Chrome even when
    // one busy device produced more than RECENT_STEPS newer actions.
    db.liveBrowserCommand
      .findMany({
        where: {
          deviceId: { in: browserDeviceIds },
          action: 'screenshot',
          createdAt: { gte: since },
          ...commandBinding,
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['deviceId', 'contextId'],
        select: {
          id: true, deviceId: true, action: true, params: true, status: true, createdAt: true,
          resolvedAt: true, turnId: true, conversationId: true, contextId: true,
        },
      })
      .catch(() => []),
    db.macAgentSessionEvent
      .findMany({
        where: { deviceId: { in: sessionDeviceIds }, createdAt: { gte: since } },
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
        where: { deviceId: { in: sessionDeviceIds }, createdAt: { gte: since } },
        orderBy: { at: 'desc' },
        distinct: ['sessionId'],
        select: { sessionId: true, tool: true, kind: true, text: true, isError: true, at: true },
      })
      .catch(() => []),
    // Whole-window cost per session — a database SUM, not a capped scan.
    db.macAgentSessionEvent
      .groupBy({
        by: ['sessionId'],
        where: { deviceId: { in: sessionDeviceIds }, createdAt: { gte: since } },
        _sum: { costUsd: true },
      })
      .catch(() => []),
    // Newest failure per session (error, or an errored turn) — for the
    // "ended after an unresolved error is still a failure" rule.
    db.macAgentSessionEvent
      .groupBy({
        by: ['sessionId'],
        where: {
          deviceId: { in: sessionDeviceIds },
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
        where: {
          deviceId: { in: sessionDeviceIds },
          createdAt: { gte: since },
          kind: 'turn_done',
          isError: false,
        },
        _max: { at: true },
      })
      .catch(() => []),
    // L7 — the newest live-stream frame's TIMESTAMP only; the payload is
    // fetched below only when it beats what the client already holds.
    db.macAgentFrame
      .findMany({
        where: {
          deviceId: { in: boundMacDeviceIds },
          at: { gte: since },
          ...commandBinding,
        },
        orderBy: { at: 'desc' },
        distinct: ['deviceId'],
        select: {
          deviceId: true,
          at: true,
          sequence: true,
          turnId: true,
          conversationId: true,
        },
      })
      .catch(() => []),
    boundRequested
      ? db.liveBrowserFrame.findMany({
        where: {
          deviceId: { in: browserDeviceIds },
          capturedAt: { gte: since },
          turnId: requestedTurnId,
          conversationId: requestedConversationId,
        },
        orderBy: { capturedAt: 'desc' },
        select: {
          deviceId: true, contextId: true, capturedAt: true, sequence: true,
          turnId: true, conversationId: true,
        },
        }).catch(() => [])
      : Promise.resolve([]),
  ])

  const steps: ActivityStep[] = []
  /** Newest wins across BOTH surfaces — not whichever list we happened to read first. */
  let screenshot: string | null = null
  let screenshotAt: string | null = null
  let screenshotSurface: Extract<ActivitySurface, 'mac' | 'browser'> | null = null
  const surfaceShots: Record<'mac' | 'browser', { screenshot: string | null; at: string | null }> = {
    mac: { screenshot: null, at: null },
    browser: { screenshot: null, at: null },
  }
  const typedBrowserRows = flattenBrowserDeviceRows(typedBrowserDevices)
  const typedBrowserFrameMetas = browserFrameMetas as BrowserFrameMetaRow[]
  const newestFrameContextByDevice = new Map<string, string>()
  for (const frame of typedBrowserFrameMetas) {
    if (!newestFrameContextByDevice.has(frame.deviceId)) {
      newestFrameContextByDevice.set(frame.deviceId, frame.contextId)
    }
  }
  for (const shot of browserShotMetaRows as Array<Omit<BrowserActivityRow, 'device'>>) {
    if (typedBrowserRows.some((row) => row.id === shot.id)) continue
    typedBrowserRows.push({
      ...shot,
      device: { name: browserDeviceNameById.get(shot.deviceId) ?? null },
    })
  }
  typedBrowserRows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const browserRowsByContext = new Map<string, BrowserActivityRow[]>()
  for (const row of typedBrowserRows) {
    row.contextId = effectiveBrowserTabContext(
      row.contextId,
      newestFrameContextByDevice.get(row.deviceId),
    )
    const id = browserPreviewId(row.deviceId, row.contextId)
    const list = browserRowsByContext.get(id) ?? []
    list.push(row)
    browserRowsByContext.set(id, list)
  }

  const typedMacRows = flattenMacDeviceRows(typedMacDevices)
  for (const shot of macShotMetaRows as MacActivityRow[]) {
    if (!typedMacRows.some((row) => row.id === shot.id)) typedMacRows.push(shot)
  }
  typedMacRows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  for (const r of typedMacRows) {
    const params = (r.params as Record<string, unknown> | null) ?? {}
    const command = typeof params.command === 'string' ? params.command : null
    const action = String(r.action)
    const proofPhase = params.proofPhase === 'before' || params.proofPhase === 'after'
      ? String(params.proofPhase)
      : null
    const proofActionLabel = typeof params.proofActionLabel === 'string' ? params.proofActionLabel : null
    const proofLabel = proofPhase
      ? `📸 ${proofPhase === 'before' ? 'BEFORE' : 'AFTER'} — ${proofActionLabel ?? 'Mac action'}`
      : null
    steps.push({
      id: r.id,
      surface: action.startsWith('session_') ? 'session' : 'mac',
      labelBn: proofLabel ?? macLabel(action, command),
      detail: proofActionLabel ?? command,
      status: normalizeStatus(r.status),
      policy: r.policyLevel ?? null,
      at: commandActivityAt(r).toISOString(),
      contextId: `mac:${r.deviceId}`,
    })
  }

  for (const r of typedBrowserRows) {
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
      at: commandActivityAt(r).toISOString(),
      contextId: browserPreviewId(r.deviceId, r.contextId),
    })
  }

  // One newest screenshot per paired Chrome context. Payloads are fetched in
  // one query only for cards the client does not already hold.
  const newestBrowserShotRows = [...browserRowsByContext.entries()]
    .map(([contextId, rows]) => ({
      contextId,
      row: rows.find((candidate) => candidate.action === 'screenshot') ?? null,
    }))
    .filter((entry): entry is { contextId: string; row: BrowserActivityRow } => Boolean(entry.row))
  const browserShotIdsToFetch = newestBrowserShotRows
    .filter(({ contextId, row }) => {
      const held = heldPreviewAt(previewAfter, hasPreviewAfter, contextId, browserScreenshotAfter)
      return !held || commandActivityAt(row).toISOString() > held
    })
    .map(({ row }) => row.id)
  const browserShotPayloadRows: Array<{ id: string; result: unknown; createdAt: Date; resolvedAt: Date | null }> =
    browserShotIdsToFetch.length
      ? await db.liveBrowserCommand.findMany({
          where: { id: { in: browserShotIdsToFetch } },
          select: { id: true, result: true, createdAt: true, resolvedAt: true },
        }).catch(() => [])
      : []
  const browserShotPayloadById = new Map(browserShotPayloadRows.map((row) => [row.id, row]))
  const browserContextShots = new Map<string, {
    screenshot: string | null
    at: string
    frameSeq: number | null
    turnId: string | null
    conversationId: string | null
  }>()
  for (const { contextId, row } of newestBrowserShotRows) {
    const full = browserShotPayloadById.get(row.id)
    const result = (full?.result as Record<string, unknown> | null) ?? null
    const frame = result && typeof result.screenshot === 'string' ? result.screenshot : null
    const at = commandActivityAt(row).toISOString()
    browserContextShots.set(contextId, {
      screenshot: frame,
      at,
      frameSeq: null,
      turnId: row.turnId ?? null,
      conversationId: row.conversationId ?? null,
    })
  }

  const browserFramePairsToFetch = typedBrowserFrameMetas.filter((row) => {
    const contextId = browserPreviewId(row.deviceId, row.contextId)
    const held = heldPreviewAt(previewAfter, hasPreviewAfter, contextId, browserScreenshotAfter)
    return !held || row.capturedAt.toISOString() > held
  })
  const browserFramePayloadRows: Array<BrowserFrameMetaRow & { dataUri: string }> =
    browserFramePairsToFetch.length > 0
      ? await db.liveBrowserFrame.findMany({
          where: {
            OR: browserFramePairsToFetch.map((row) => ({
              deviceId: row.deviceId,
              contextId: row.contextId,
              turnId: row.turnId,
              conversationId: row.conversationId,
              capturedAt: row.capturedAt,
              sequence: row.sequence,
            })),
          },
          select: {
            deviceId: true, contextId: true, dataUri: true, capturedAt: true,
            sequence: true, turnId: true, conversationId: true,
          },
        }).catch(() => [])
      : []
  const browserFramePayloadByContext = new Map(
    browserFramePayloadRows.map((row) => [browserPreviewId(row.deviceId, row.contextId), row]),
  )
  for (const row of typedBrowserFrameMetas) {
    const contextId = browserPreviewId(row.deviceId, row.contextId)
    const at = row.capturedAt.toISOString()
    const current = browserContextShots.get(contextId)
    if (current && current.at >= at) continue
    const full = browserFramePayloadByContext.get(contextId)
    browserContextShots.set(contextId, {
      screenshot: full?.dataUri?.startsWith('data:image') ? full.dataUri : null,
      at,
      frameSeq: row.sequence,
      turnId: row.turnId,
      conversationId: row.conversationId,
    })
  }
  const newestBrowserContextShot = [...browserContextShots.values()]
    .sort((a, b) => b.at.localeCompare(a.at))[0]
  if (newestBrowserContextShot) {
    surfaceShots.browser = newestBrowserContextShot
    const heldScreenshotAt = screenshotAt as string | null
    if (!heldScreenshotAt || newestBrowserContextShot.at > heldScreenshotAt) {
      screenshot = newestBrowserContextShot.screenshot
      screenshotAt = newestBrowserContextShot.at
      screenshotSurface = 'browser'
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

  const frameMetaRows = frameMetas as MacFrameMetaRow[]
  const freshFrameMetaRows = frameMetaRows.filter((row) => Date.now() - row.at.getTime() < 10_000)
  const macRowsByDevice = new Map<string, MacActivityRow[]>()
  for (const row of typedMacRows) {
    const rows = macRowsByDevice.get(row.deviceId) ?? []
    rows.push(row)
    macRowsByDevice.set(row.deviceId, rows)
  }
  for (const rows of macRowsByDevice.values()) {
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  // Resolve one independent screenshot tuple per Mac. Payload queries remain
  // conditional and batched, but timestamps/pixels never cross device ids.
  const newestMacCommandShots = [...macRowsByDevice.values()]
    .map((rows) => rows.find(
      (row) => row.action === 'screenshot' || row.action === 'ui_screenshot',
    ) ?? null)
    .filter((row): row is MacActivityRow => row !== null)
  const macCommandIdsToFetch = newestMacCommandShots
    .filter((row) => {
      const contextId = `mac:${row.deviceId}`
      const held = heldPreviewAt(previewAfter, hasPreviewAfter, contextId, macScreenshotAfter)
      return !held || commandActivityAt(row).toISOString() > held
    })
    .map((row) => row.id)
  const macCommandPayloadRows: Array<{
    id: string
    stdout: string | null
    createdAt: Date
    resolvedAt: Date | null
  }> =
    macCommandIdsToFetch.length
      ? await db.macAgentCommand.findMany({
          where: { id: { in: macCommandIdsToFetch } },
          select: { id: true, stdout: true, createdAt: true, resolvedAt: true },
        }).catch(() => [])
      : []
  const macCommandPayloadById = new Map(macCommandPayloadRows.map((row) => [row.id, row]))
  const macShotsByDevice = new Map<string, {
    screenshot: string | null
    at: string
    frameSeq: number | null
  }>()
  for (const row of newestMacCommandShots) {
    const full = macCommandPayloadById.get(row.id)
    const dataUri = typeof full?.stdout === 'string' && full.stdout.startsWith('data:image')
      ? full.stdout : null
    macShotsByDevice.set(row.deviceId, {
      screenshot: dataUri,
      at: commandActivityAt(row).toISOString(),
      frameSeq: null,
    })
  }

  const frameMetasToFetch = frameMetaRows
    .filter((row) => {
      const contextId = `mac:${row.deviceId}`
      const held = heldPreviewAt(previewAfter, hasPreviewAfter, contextId, macScreenshotAfter)
      return !held || row.at.toISOString() > held
    })
  const macFramePayloadRows: Array<MacFrameMetaRow & { dataUri: string }> =
    frameMetasToFetch.length
      ? await db.macAgentFrame.findMany({
          where: {
            OR: frameMetasToFetch.map((row) => ({
              deviceId: row.deviceId,
              at: row.at,
              sequence: row.sequence,
              turnId: row.turnId,
              conversationId: row.conversationId,
            })),
          },
          select: {
            deviceId: true,
            dataUri: true,
            at: true,
            sequence: true,
            turnId: true,
            conversationId: true,
          },
        }).catch(() => [])
      : []
  const macFramePayloadByDevice = new Map(
    macFramePayloadRows.map((row) => [
      `${row.deviceId}:${row.sequence}:${row.at.toISOString()}`,
      row,
    ]),
  )
  for (const frame of frameMetaRows) {
    const iso = frame.at.toISOString()
    const current = macShotsByDevice.get(frame.deviceId)
    if (current && current.at >= iso) continue
    const full = macFramePayloadByDevice.get(`${frame.deviceId}:${frame.sequence}:${iso}`)
    const exactActivity = full
      ? sameMacFrameActivity(full, requestedTurnId, requestedConversationId)
      : false
    const dataUri = exactActivity && full?.dataUri?.startsWith('data:image') ? full.dataUri : null
    macShotsByDevice.set(frame.deviceId, {
      screenshot: dataUri,
      at: iso,
      frameSeq: frame.sequence,
    })
  }

  const newestMacShot = [...macShotsByDevice.values()]
    .sort((a, b) => b.at.localeCompare(a.at))[0]
  if (newestMacShot) surfaceShots.mac = newestMacShot

  // L9-B — a broadcaster stamp belongs only to its own Mac preview.
  const videoStampKeys = freshFrameMetaRows.map((row) => `mac_video_active:${row.deviceId}`)
  const videoStampRows: Array<{ key: string; value: string }> = videoStampKeys.length
    ? await db.agentKvSetting.findMany({
        where: { key: { in: videoStampKeys } },
        select: { key: true, value: true },
      }).catch(() => [])
    : []
  const activeVideoDeviceIds = new Set(
    videoStampRows
      .filter((row) => macVideoStampIsActive(
        row.value,
        requestedTurnId,
        requestedConversationId,
      ))
      .map((row) => row.key.slice('mac_video_active:'.length)),
  )
  const videoIdentityAllowed = activityAllowsVideoIdentity(
    boundRequested,
    boundTurn?.status ?? null,
  )
  const videoDeviceId = videoIdentityAllowed
    ? freshFrameMetaRows.find((row) => activeVideoDeviceIds.has(row.deviceId))?.deviceId ?? null
    : null

  // RC-3 — screens available on the streaming Mac, so the dock can offer a
  // picker. Absent (or 1) means there is nothing to choose.
  let macDisplays: { count: number; index: number } | null = null
  if (videoDeviceId) {
    const row = await db.agentKvSetting
      .findUnique({ where: { key: `mac_displays:${videoDeviceId}` }, select: { value: true } })
      .catch(() => null)
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value) as { count?: number; index?: number }
        if (typeof parsed.count === 'number' && parsed.count > 0) {
          macDisplays = { count: parsed.count, index: parsed.index ?? 0 }
        }
      } catch {
        /* a malformed row is simply no picker */
      }
    }
  }

  // Keep the legacy single-frame fields truthful for older clients while the
  // new docks consume the independent preview deck below.
  const newestSurface = (['browser', 'mac'] as const)
    .filter((surface) => surfaceShots[surface].at)
    .sort((a, b) => surfaceShots[b].at!.localeCompare(surfaceShots[a].at!))[0]
  if (newestSurface) {
    screenshotAt = surfaceShots[newestSurface].at
    screenshotSurface = newestSurface
    screenshot = surfaceShots[newestSurface].screenshot
  }
  const heldAt = screenshotAt as string | null
  if (screenshotAfter && heldAt && heldAt <= screenshotAfter) screenshot = null

  const browserFrameMetaByContext = new Map(
    typedBrowserFrameMetas.map((row) => [browserPreviewId(row.deviceId, row.contextId), row]),
  )
  const browserContextIds = new Set([
    ...browserRowsByContext.keys(),
    ...browserContextShots.keys(),
  ])
  const browserPreviews = [...browserContextIds].map<ActivityPreview | null>((contextId) => {
    const rows = browserRowsByContext.get(contextId) ?? []
    const sourceCurrent = rows.find((row) => {
      const status = normalizeStatus(row.status)
      return status === 'running' || status === 'queued'
    }) ?? rows.find((row) => commandActivityAt(row).toISOString() > justFinishedCutoff) ?? rows[0]
    const legacySourceActive = rows.some((row) => {
      const status = normalizeStatus(row.status)
      return status === 'running' || status === 'queued'
        || commandActivityAt(row).toISOString() > justFinishedCutoff
    })
    const shot = browserContextShots.get(contextId)
    const frameMeta = browserFrameMetaByContext.get(contextId)
    const frameFresh = Boolean(frameMeta && Date.now() - frameMeta.capturedAt.getTime() < 5_000)
    const hasSource = rows.length > 0 || Boolean(shot)
    const sourceActive = boundRequested
      ? boundTurn?.status === 'running' && hasSource
      : legacySourceActive || frameFresh
    if (!shot && !sourceActive && rows.length === 0) return null
    const baseLabel = sourceCurrent
      ? (BROWSER_LABEL[sourceCurrent.action] ?? `🌐 ${sourceCurrent.action}`)
      : '🌐 ব্রাউজারে কাজ করছে'
    const deviceId = sourceCurrent?.deviceId ?? frameMeta?.deviceId ?? ''
    const deviceName = sourceCurrent?.device?.name?.trim()
      ?? browserDeviceNameById.get(deviceId)?.trim()
    const activityAt = [
      shot?.at ?? null,
      sourceCurrent ? commandActivityAt(sourceCurrent).toISOString() : null,
    ].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
    return {
      surface: 'browser' as const,
      contextId,
      screenshot: shot?.screenshot ?? null,
      screenshotAt: shot?.at ?? null,
      labelBn: browserContextIds.size > 1 && deviceName
        ? `${baseLabel} · ${deviceName}` : baseLabel,
      active: sourceActive,
      turnId: shot?.turnId ?? sourceCurrent?.turnId ?? requestedTurnId,
      conversationId: shot?.conversationId ?? sourceCurrent?.conversationId ?? requestedConversationId,
      activityId: requestedTurnId ? `turn:${requestedTurnId}:${contextId}` : null,
      sourceState: boundRequested
        ? boundPreviewSourceState({
            turnStatus: boundTurn?.status ?? null,
            hasSource,
            hasFreshFrame: frameFresh,
          })
        : frameFresh ? 'live' : sourceActive ? 'between_steps' : 'done',
      activityAt,
      frameAt: shot?.at ?? null,
      frameSeq: shot?.frameSeq ?? null,
    }
  }).filter((preview): preview is ActivityPreview => preview !== null)

  const macPreviewStates = macDeviceIds.map<MacPreviewState>((deviceId) => {
    const sourceRows = (macRowsByDevice.get(deviceId) ?? [])
      .filter((row) => !row.action.startsWith('session_'))
    const sourceCurrent =
      sourceRows.find((row) => {
        const status = normalizeStatus(row.status)
        return status === 'running' || status === 'queued'
      }) ??
      sourceRows.find((row) => commandActivityAt(row).toISOString() > justFinishedCutoff) ??
      sourceRows[0]
    const frameActive = freshFrameMetaRows.some((row) => row.deviceId === deviceId)
    const legacySourceActive = sourceRows.some((row) => {
      const status = normalizeStatus(row.status)
      return status === 'running' || status === 'queued'
        || commandActivityAt(row).toISOString() > justFinishedCutoff
    }) || frameActive
    const params = (sourceCurrent?.params as Record<string, unknown> | null) ?? null
    const command = params && typeof params.command === 'string' ? params.command : null
    const baseLabel = sourceCurrent
      ? macLabel(sourceCurrent.action, command)
      : '💻 Mac-এ কাজ করছে'
    const deviceName = macDeviceNameById.get(deviceId)?.trim()
    const shot = macShotsByDevice.get(deviceId)
    const hasSource = sourceRows.length > 0 || Boolean(shot)
    const sourceActive = boundRequested
      ? boundTurn?.status === 'running' && hasSource
      : legacySourceActive
    const videoActive = videoIdentityAllowed
      && activeVideoDeviceIds.has(deviceId)
      && (!boundRequested || hasSource)
    const activityAt = [
      shot?.at ?? null,
      sourceCurrent ? commandActivityAt(sourceCurrent).toISOString() : null,
    ].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
    const autoStreamOwned = sourceRows.some((row) => {
      if (row.action !== 'screen_stream') return false
      const stream = (row.params as Record<string, unknown> | null) ?? null
      return stream?.mode === 'start' && stream?.reason === 'computer_use'
    })
    return {
      deviceId,
      screenshot: shot?.screenshot ?? null,
      screenshotAt: shot?.at ?? null,
      labelBn: macDeviceIds.length > 1 && deviceName
        ? `${baseLabel} · ${deviceName}` : baseLabel,
      active: sourceActive,
      videoActive,
      turnId: sourceCurrent?.turnId ?? requestedTurnId,
      conversationId: sourceCurrent?.conversationId ?? requestedConversationId,
      activityId: requestedTurnId ? `turn:${requestedTurnId}:mac:${deviceId}` : null,
      sourceState: boundRequested
        ? boundPreviewSourceState({
            turnStatus: boundTurn?.status ?? null,
            hasSource,
            hasFreshFrame: frameActive,
          })
        : frameActive ? 'live' : sourceActive ? 'between_steps' : 'done',
      activityAt,
      frameSeq: shot?.frameSeq ?? null,
      autoStreamOwned,
    }
  })
  const macPreviews = projectMacPreviews(macPreviewStates)

  const previews = [...browserPreviews, ...macPreviews]
    .sort((a, b) => Number(b.active) - Number(a.active)
      || (b.screenshotAt ?? '').localeCompare(a.screenshotAt ?? ''))

  return Response.json(
    {
      // The dock shows itself only while something is genuinely in flight — the
      // owner should never have a player sitting on his chat doing nothing. A
      // live stream IS work in flight: a frame fresher than ~10s keeps the
      // dock up and the poll fast even when no command row moved.
      active: boundRequested
        ? boundTurn?.status === 'running' && (previews.length > 0 || trimmed.length > 0)
        : activityFeedIsActive({
          runningCount: running.length,
          justFinishedCount: justFinished.length,
          previews,
          freshMacFrameCount: freshFrameMetaRows.length,
          }),
      /** L7 — server truth for the docks' stream toggle: a client that
       *  remounts mid-stream must show STOP, not a second start. */
      streaming: videoIdentityAllowed && freshFrameMetaRows.length > 0,
      current: running[0] ?? justFinished[0] ?? trimmed[0] ?? null,
      steps: trimmed,
      /** L5: per-session status + cost for the expanded view. */
      sessions,
      screenshot,
      screenshotAt,
      /** The frame's source can differ from `current` when a session event
       *  lands after a browser action. The mini-player labels the picture,
       *  not whichever unrelated event happened to be newest. */
      screenshotSurface,
      /** Independent surface cards: a fast Mac stream must not erase the
       *  Browser frame underneath it (or vice versa). */
      previews,
      /** L9-B — non-null while the Agora VIDEO broadcaster is live for this
       *  device; the dock joins `mac-screen-<id>` via screen-video-token. */
      videoDeviceId: singleMacPreviewVideoDeviceId(macPreviews),
      /** RC-3 — { count, index } for the Mac currently streaming. */
      macDisplays: macPreviews.length === 1 ? macDisplays : null,
      /** Exact task identity/lifecycle requested by the current native chat. */
      activity: boundRequested ? {
        turnId: requestedTurnId,
        conversationId: requestedConversationId,
        status: boundTurn?.status ?? 'missing',
        startedAt: boundTurn?.startedAt?.toISOString() ?? null,
        finishedAt: boundTurn?.finishedAt?.toISOString() ?? null,
      } : null,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
