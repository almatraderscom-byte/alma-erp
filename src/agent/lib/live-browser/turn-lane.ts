import { createHash, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { isDirectYouTubeBrowserTask, isPotentialYouTubeComputerUseMutation } from './intent'

// This is deliberately a durable server-owned lane, not a transcript heuristic.
// AgentConversationFocus already gives us a lease column and optimistic version;
// the deterministic id makes the one row per conversation enforceable by the DB.
const db = prisma as any

const DIRECT_YOUTUBE_LANE_KIND = 'direct_youtube_browser'
const DIRECT_YOUTUBE_LANE_ID_PREFIX = 'direct-youtube-lane:'
const MAX_CAS_ATTEMPTS = 4
// Kept local to avoid a turn-lane <-> companion import cycle. These values are
// the shared durable dispatch fence written by global owner STOP.
const LIVE_BROWSER_ENABLED_KEY = 'live_browser_enabled'
const LIVE_BROWSER_DISPATCH_NOT_BEFORE_KEY = 'live_browser_dispatch_not_before'

export const DIRECT_YOUTUBE_LANE_MAX_LEASE_MS = 10 * 60_000
export const DIRECT_YOUTUBE_LANE_ACTIVE_LEASE_MS = 5 * 60_000
export const DIRECT_YOUTUBE_LANE_UNAVAILABLE_TOOL_NAMES = new Set<string>([
  'live_browser_status',
])
export const DIRECT_YOUTUBE_LANE_SETTLEMENT_BLOCKER =
  '⚠️ Playback proof পাওয়া গেলেও durable browser lane safely close করা যায়নি, তাই completion final করছি না। নতুন করে playback request দিন।'
export const DIRECT_YOUTUBE_LANE_UNAVAILABLE_BLOCKER =
  '⚠️ আগের playback task-এর durable continuation state যাচাই করা যায়নি। তাই playback চলছে বলে দাবি করছি না বা browser action চালাচ্ছি না—requested title-সহ playback requestটি আবার দিন।'
export const DIRECT_YOUTUBE_ROUTE_MISS_BLOCKER =
  '⚠️ এই YouTube computer-use কথাটি witnessed direct lane হিসেবে নির্ভুলভাবে route করা যায়নি। ' +
  'তাই কোনো browser, workflow বা background action চালাইনি এবং কাজটি হয়েছে বলে দাবি করছি না—YouTube-এ কী search/play করতে চান, সরাসরি আবার বলুন।'

type OpenLaneStep = 'open' | 'continuing' | 'awaiting_owner'
export type DirectYouTubeLaneOutcome =
  | 'completed'
  | 'terminal_blocker'
  | 'awaiting_owner'
  | 'continuing'

interface DirectYouTubeLaneRow {
  id: string
  conversationId: string
  kind: string
  status: string
  goal: string
  currentStep: string | null
  artifacts: {
    laneToken?: unknown
    expectedOwnerReplies?: unknown
    expectedAskCardId?: unknown
    selectedOwnerReply?: unknown
    deviceOptions?: unknown
    selectedDeviceId?: unknown
    selectedDeviceName?: unknown
    selectedDeviceOption?: unknown
    selectedMediaVideoId?: unknown
    selectedMediaTitle?: unknown
    selectedMediaFingerprint?: unknown
    invalidatedAskCardIds?: unknown
  } | null
  version: number
  leaseUntil: Date | null
}

export interface DirectYouTubeReadyTurnLane {
  state: 'ready'
  ownerRequest: string
  /** Per-turn fencing token: an old/slow turn cannot settle a newer lane. */
  token: string
  /** Exact answer bound to the persisted ask-card id, never transcript-guessed. */
  selectedOwnerReply?: string
  /** Immutable server-owned device binding selected from the persisted card snapshot. */
  selectedDeviceId?: string
  /** Display name at snapshot time; a later rename invalidates the binding. */
  selectedDeviceName?: string
}

export interface DirectYouTubeDeviceOptionBinding {
  option: string
  deviceId: string
  deviceName: string
}

export type DirectYouTubeDeviceSelection =
  | { state: 'none' }
  | { state: 'required'; options: DirectYouTubeDeviceOptionBinding[] }
  | ({ state: 'selected'; selectedOption: string } & Omit<DirectYouTubeDeviceOptionBinding, 'option'>)
  | { state: 'unavailable' }

export interface DirectYouTubeSelectedMediaIdentity {
  videoId: string
  title: string
  fingerprint: string
}

export type DirectYouTubeSelectedMediaState =
  | { state: 'none' }
  | ({ state: 'selected' } & DirectYouTubeSelectedMediaIdentity)
  | { state: 'unavailable' }

export interface DirectYouTubeUnavailableTurnLane {
  state: 'unavailable'
  /** The current owner text only; never recovered from transcript history. */
  ownerRequest: string
  token: null
  /** Server-authored reason-specific final replacement. */
  blockerText?: string
}

export type DirectYouTubeTurnLane = DirectYouTubeReadyTurnLane | DirectYouTubeUnavailableTurnLane

/** Availability is a server fact, so it gates every model-authored final line. */
export function hardGateUnavailableDirectYouTubeLane(
  lane: DirectYouTubeTurnLane | null,
): { text: string; replaced: true } | null {
  return lane?.state === 'unavailable'
    ? { text: lane.blockerText ?? DIRECT_YOUTUBE_LANE_UNAVAILABLE_BLOCKER, replaced: true }
    : null
}

export class DirectYouTubeLaneStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'DirectYouTubeLaneStoreError'
  }
}

const BROWSER_CONTINUATION = new RegExp(
  [
    '^(?:continue|resume|retry|again|done|ready|paired|connected|logged\\s*in|go\\s+ahead|yes|yep|ok(?:ay)?)$',
    '^(?:হ্যাঁ|হ্যা|জি|ঠিক\\s*আছে|চালাও|এগোও|আবার|রেডি|হয়ে\\s*গেছে|হয়েছে|করেছি|পেয়ারড|পেয়ারড|লগইন\\s*করেছি)$',
    '^(?:(?:this|my|the|use)\\s+)?(?:mac(?:book)?|windows|chrome)(?:\\s+(?:chrome|browser|device))?$',
    '^(?:(?:এই|আমার|ওই)\\s*)?(?:ম্যাক|ম্যাকবুক|উইন্ডোজ|ক্রোম)(?:টা|টি)?(?:\\s*(?:ক্রোম|ব্রাউজার|ডিভাইস))?$',
    '^(?:first|second|third|প্রথমটা|দ্বিতীয়টা|দ্বিতীয়টা|তৃতীয়টা|তৃতীয়টা)$',
  ].join('|'),
  'iu',
)

const BROWSER_CANCEL = /^(?:cancel|stop|never\s*mind|বাদ|বাতিল|থামো|থামুন|আর\s*না)$/iu

const SELECT = {
  id: true,
  conversationId: true,
  kind: true,
  status: true,
  goal: true,
  currentStep: true,
  artifacts: true,
  version: true,
  leaseUntil: true,
} as const

function laneId(conversationId: string): string {
  const digest = createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
  return `${DIRECT_YOUTUBE_LANE_ID_PREFIX}${digest}`
}

/** Deterministic durable-row identity used by the command bus's final lock. */
export function directYouTubeLaneIdForConversation(conversationId: string): string {
  return laneId(conversationId)
}

/**
 * Cross-table authority mutex shared by lane admission and owner Stop. A row
 * lock cannot protect the initial "no lane row yet" case; this xact-scoped
 * lock does, without leaving a recoverable application lease behind.
 */
export async function lockDirectYouTubeLaneAuthority(
  tx: typeof db,
  conversationId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${laneId(conversationId)}, 0)
    )::text AS lock_token
  `)
}

/** Global dispatch mutex. Every authority-granting lane transition takes the
 * conversation lock first and this lock second, matching command enqueue and
 * owner Stop's lock order. */
async function lockLiveBrowserDispatchAuthority(tx: typeof db): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended('alma_live_browser_dispatch_global', 0)
    )::text AS lock_token /* live_browser_dispatch_global */
  `)
}

function laneToken(row: DirectYouTubeLaneRow): string {
  const value = row.artifacts?.laneToken
  return typeof value === 'string' ? value.trim() : ''
}

function expectedOwnerReplyMatches(row: DirectYouTubeLaneRow, text: string): boolean {
  const expected = row.artifacts?.expectedOwnerReplies
  if (!Array.isArray(expected)) return false
  const normalized = text.trim().toLocaleLowerCase()
  return expected.some((value) => (
    typeof value === 'string' && value.trim().toLocaleLowerCase() === normalized
  ))
}

function expectedAskCardId(row: DirectYouTubeLaneRow): string {
  const value = row.artifacts?.expectedAskCardId
  return typeof value === 'string' ? value.trim() : ''
}

function invalidatedAskCardIds(row: DirectYouTubeLaneRow): string[] {
  const values = row.artifacts?.invalidatedAskCardIds
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))]
}

function invalidatedAskCardArtifacts(
  row: DirectYouTubeLaneRow,
  includeExpected: boolean = false,
): { invalidatedAskCardIds?: string[] } {
  const ids = invalidatedAskCardIds(row)
  const expected = includeExpected ? expectedAskCardId(row) : ''
  if (expected && !ids.includes(expected)) ids.push(expected)
  return ids.length ? { invalidatedAskCardIds: ids } : {}
}

/**
 * Close the UI admission point as well as the lane artifact. `answered` is
 * included because a same-answer re-tap is otherwise idempotently accepted by
 * the generic ask-card API after this direct lane has ended.
 */
export async function supersedeDirectYouTubeAskCards(
  conversationId: string,
  ids: string[],
): Promise<boolean> {
  return supersedeDirectYouTubeAskCardsWith(db, conversationId, ids)
}

async function supersedeDirectYouTubeAskCardsWith(
  client: typeof db,
  conversationId: string,
  ids: string[],
): Promise<boolean> {
  const cardIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (!cardIds.length) return true
  if (!conversationId.trim()) return false
  try {
    await client.agentAskCard.updateMany({
      where: {
        id: { in: cardIds },
        conversationId,
        status: { in: ['pending', 'answered'] },
      },
      data: { status: 'superseded' },
    })
    return true
  } catch {
    return false
  }
}

async function supersedeExpectedAskCard(
  row: DirectYouTubeLaneRow,
  client: typeof db = db,
): Promise<boolean> {
  const cardId = expectedAskCardId(row)
  if (!cardId) return true
  return supersedeDirectYouTubeAskCardsWith(client, row.conversationId, [cardId])
}

function deviceOptions(row: DirectYouTubeLaneRow): DirectYouTubeDeviceOptionBinding[] {
  const value = row.artifacts?.deviceOptions
  if (!Array.isArray(value)) return []
  const parsed: DirectYouTubeDeviceOptionBinding[] = []
  const options = new Set<string>()
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return []
    const option = 'option' in candidate && typeof candidate.option === 'string'
      ? candidate.option.trim()
      : ''
    const deviceId = 'deviceId' in candidate && typeof candidate.deviceId === 'string'
      ? candidate.deviceId.trim()
      : ''
    const deviceName = 'deviceName' in candidate && typeof candidate.deviceName === 'string'
      ? candidate.deviceName.trim()
      : ''
    if (!option || !deviceId || !deviceName || options.has(option) || ids.has(deviceId)) return []
    options.add(option)
    ids.add(deviceId)
    parsed.push({ option, deviceId, deviceName })
  }
  return parsed
}

function selectedDevice(row: DirectYouTubeLaneRow): {
  selectedOption: string
  deviceId: string
  deviceName: string
} | null {
  const selectedOption = typeof row.artifacts?.selectedDeviceOption === 'string'
    ? row.artifacts.selectedDeviceOption.trim()
    : ''
  const deviceId = typeof row.artifacts?.selectedDeviceId === 'string'
    ? row.artifacts.selectedDeviceId.trim()
    : ''
  const deviceName = typeof row.artifacts?.selectedDeviceName === 'string'
    ? row.artifacts.selectedDeviceName.trim()
    : ''
  if (!selectedOption || !deviceId || !deviceName) return null
  const snapshot = deviceOptions(row)
  const match = snapshot.find((binding) => binding.option === selectedOption)
  return match && match.deviceId === deviceId && match.deviceName === deviceName
    ? { selectedOption, deviceId, deviceName }
    : null
}

function selectedMedia(row: DirectYouTubeLaneRow): DirectYouTubeSelectedMediaIdentity | null {
  const videoId = typeof row.artifacts?.selectedMediaVideoId === 'string'
    ? row.artifacts.selectedMediaVideoId.trim()
    : ''
  const title = typeof row.artifacts?.selectedMediaTitle === 'string'
    ? row.artifacts.selectedMediaTitle.trim()
    : ''
  const fingerprint = typeof row.artifacts?.selectedMediaFingerprint === 'string'
    ? row.artifacts.selectedMediaFingerprint.trim()
    : ''
  return /^[A-Za-z0-9_-]{11}$/.test(videoId) && title && fingerprint
    ? { videoId, title, fingerprint }
    : null
}

function durableDeviceArtifacts(row: DirectYouTubeLaneRow): Record<string, unknown> {
  const snapshot = deviceOptions(row)
  const selected = selectedDevice(row)
  const media = selectedMedia(row)
  return {
    ...invalidatedAskCardArtifacts(row),
    ...(snapshot.length ? { deviceOptions: snapshot } : {}),
    ...(selected
      ? {
          selectedDeviceId: selected.deviceId,
          selectedDeviceName: selected.deviceName,
          selectedDeviceOption: selected.selectedOption,
        }
      : {}),
    ...(media
      ? {
          selectedMediaVideoId: media.videoId,
          selectedMediaTitle: media.title,
          selectedMediaFingerprint: media.fingerprint,
        }
      : {}),
  }
}

function buildDeviceOptionSnapshot(
  devices: Array<{ deviceId: string; deviceName: string }>,
): DirectYouTubeDeviceOptionBinding[] | null {
  const normalized = devices.map((device) => ({
    deviceId: device.deviceId.trim(),
    deviceName: device.deviceName.trim(),
  }))
  if (normalized.length < 1 || normalized.some((device) => !device.deviceId || !device.deviceName)) {
    return null
  }
  const ids = new Set(normalized.map((device) => device.deviceId))
  if (ids.size !== normalized.length) return null
  normalized.sort((a, b) => a.deviceId.localeCompare(b.deviceId))
  const nameCounts = new Map<string, number>()
  for (const device of normalized) {
    const key = device.deviceName.toLocaleLowerCase()
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  const usedOptions = new Set<string>()
  const bindings = normalized.map((device) => {
    const duplicateName = (nameCounts.get(device.deviceName.toLocaleLowerCase()) ?? 0) > 1
    let option = duplicateName
      ? `${device.deviceName} · ${device.deviceId}`
      : device.deviceName
    if (usedOptions.has(option)) option = `${device.deviceName} · ${device.deviceId}`
    if (usedOptions.has(option)) return null
    usedOptions.add(option)
    return { option, ...device }
  })
  return bindings.every((binding): binding is DirectYouTubeDeviceOptionBinding => Boolean(binding))
    ? bindings
    : null
}

function sameDeviceSnapshot(
  left: DirectYouTubeDeviceOptionBinding[],
  right: DirectYouTubeDeviceOptionBinding[],
): boolean {
  return left.length === right.length && left.every((binding, index) => (
    binding.option === right[index]?.option
    && binding.deviceId === right[index]?.deviceId
    && binding.deviceName === right[index]?.deviceName
  ))
}

function isOpenRow(row: DirectYouTubeLaneRow, now: Date): boolean {
  return (
    row.kind === DIRECT_YOUTUBE_LANE_KIND
    && (row.status === 'active' || row.status === 'awaiting_owner')
    && (row.currentStep === 'open' || row.currentStep === 'continuing' || row.currentStep === 'awaiting_owner')
    && row.leaseUntil instanceof Date
    && row.leaseUntil.getTime() > now.getTime()
    && Boolean(laneToken(row))
    && isDirectYouTubeBrowserTask(row.goal)
  )
}

function boundedLease(now: Date, leaseMs: number): Date {
  return new Date(now.getTime() + Math.min(Math.max(1, leaseMs), DIRECT_YOUTUBE_LANE_MAX_LEASE_MS))
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

async function readLane(
  conversationId: string,
  client: typeof db = db,
): Promise<DirectYouTubeLaneRow | null> {
  return client.agentConversationFocus.findUnique({
    where: { id: laneId(conversationId) },
    select: SELECT,
  }) as Promise<DirectYouTubeLaneRow | null>
}

type OwnerTurnFence = {
  id: string
  conversationId: string
  status: string
  cancelRequested: boolean
  startedAt: Date
  userMessageId: string | null
}

type LiveBrowserDispatchBoundary = {
  valid: boolean
  at: Date | null
}

async function readOwnerTurnFence(
  conversationId: string,
  token: string,
  client: typeof db = db,
): Promise<OwnerTurnFence | null> {
  if (!conversationId || !token) return null
  try {
    const turn = await client.agentTurn.findUnique({
      where: { id: token },
      select: {
        id: true,
        conversationId: true,
        status: true,
        cancelRequested: true,
        startedAt: true,
        userMessageId: true,
      },
    }) as OwnerTurnFence | null
    return turn?.conversationId === conversationId && turn.startedAt instanceof Date
      ? turn
      : null
  } catch {
    return null
  }
}

async function readLiveBrowserDispatchBoundary(
  client: typeof db,
): Promise<LiveBrowserDispatchBoundary> {
  const row = await client.agentKvSetting.findUnique({
    where: { key: LIVE_BROWSER_DISPATCH_NOT_BEFORE_KEY },
    select: { value: true },
  })
  const value = typeof row?.value === 'string' ? row.value.trim() : ''
  if (!value) return { valid: true, at: null }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? { valid: true, at: new Date(timestamp) }
    : { valid: false, at: null }
}

function ownerTurnPassesDispatchBoundary(
  turn: OwnerTurnFence,
  boundary: LiveBrowserDispatchBoundary,
): boolean {
  return boundary.valid
    && (!boundary.at || turn.startedAt.getTime() > boundary.at.getTime())
}

async function readRunningOwnerTurnAfterDispatchBoundary(
  conversationId: string,
  token: string,
  client: typeof db,
  boundary: LiveBrowserDispatchBoundary,
): Promise<OwnerTurnFence | null> {
  const turn = await readOwnerTurnFence(conversationId, token, client)
  return turn
    && turn.status === 'running'
    && turn.cancelRequested === false
    && ownerTurnPassesDispatchBoundary(turn, boundary)
    ? turn
    : null
}

async function isRunningOwnerTurn(
  conversationId: string,
  token: string,
  client: typeof db = db,
): Promise<boolean> {
  const turn = await readOwnerTurnFence(conversationId, token, client)
  return Boolean(turn && turn.status === 'running' && turn.cancelRequested === false)
}

async function persistedLaneTurnWasCanceled(row: DirectYouTubeLaneRow): Promise<boolean> {
  const token = laneToken(row)
  if (!token) return true
  try {
    const turn = await db.agentTurn.findUnique({
      where: { id: token },
      select: { conversationId: true, status: true, cancelRequested: true },
    })
    return !turn
      || turn.conversationId !== row.conversationId
      || turn.status === 'canceled'
      || turn.cancelRequested === true
  } catch {
    // An unreadable turn fence is not permission to resume browser authority.
    return true
  }
}

async function appendLaneEvent(
  row: DirectYouTubeLaneRow,
  type: string,
  fromStatus: string | null,
  toStatus: string,
  version: number,
  client: typeof db = db,
): Promise<void> {
  await client.agentFocusEvent.create({
    data: {
      focusId: row.id,
      conversationId: row.conversationId,
      type,
      fromStatus,
      toStatus,
      version,
      cause: 'direct_browser_lane',
      detail: { step: row.currentStep },
    },
  }).catch(() => {})
}

async function openDirectYouTubeLane(
  conversationId: string,
  ownerRequest: string,
  token: string,
  now: Date,
): Promise<DirectYouTubeReadyTurnLane> {
  return db.$transaction(async (tx: typeof db) => {
    await lockDirectYouTubeLaneAuthority(tx, conversationId)
    await lockLiveBrowserDispatchAuthority(tx)
    const boundary = await readLiveBrowserDispatchBoundary(tx)
    const incomingTurn = await readRunningOwnerTurnAfterDispatchBoundary(
      conversationId,
      token,
      tx,
      boundary,
    )
    if (!incomingTurn) {
      throw new DirectYouTubeLaneStoreError('direct YouTube lane turn is not running')
    }
    return openDirectYouTubeLaneLocked(
      conversationId,
      ownerRequest,
      token,
      now,
      incomingTurn,
      tx,
    )
  })
}

async function openDirectYouTubeLaneLocked(
  conversationId: string,
  ownerRequest: string,
  token: string,
  now: Date,
  incomingTurn: OwnerTurnFence,
  client: typeof db,
): Promise<DirectYouTubeReadyTurnLane> {
  const id = laneId(conversationId)
  const leaseUntil = boundedLease(now, DIRECT_YOUTUBE_LANE_ACTIVE_LEASE_MS)
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    if (!(await isRunningOwnerTurn(conversationId, token, client))) {
      throw new DirectYouTubeLaneStoreError('direct YouTube lane turn stopped before persistence')
    }
    const current = await readLane(conversationId, client)
    if (!current) {
      try {
        const created = await client.agentConversationFocus.create({
          data: {
            id,
            conversationId,
            businessId: 'ALMA_LIFESTYLE',
            status: 'active',
            goal: ownerRequest.slice(0, 2000),
            kind: DIRECT_YOUTUBE_LANE_KIND,
            currentStep: 'open',
            nextActions: ['live_browser_status', 'live_browser_look', 'live_browser_act'],
            completionCriteria: 'Fresh server-verified YouTube playback proof',
            artifacts: { laneToken: token },
            leaseUntil,
          },
          select: SELECT,
        }) as DirectYouTubeLaneRow
        await appendLaneEvent(created, 'created', null, 'active', created.version, client)
        return { state: 'ready', ownerRequest, token }
      } catch (error) {
        if (isUniqueConflict(error)) continue
        throw error
      }
    }

    const currentToken = laneToken(current)
    if (currentToken !== token) {
      const currentTurn = await readOwnerTurnFence(conversationId, currentToken, client)
      if (
        !currentTurn
        || currentTurn.startedAt.getTime() >= incomingTurn.startedAt.getTime()
      ) {
        throw new DirectYouTubeLaneStoreError('older/equal direct turn cannot replace newer lane authority')
      }
    }
    if (!(await supersedeExpectedAskCard(current, client))) {
      throw new DirectYouTubeLaneStoreError('could not supersede prior direct-lane ask card')
    }
    const updated = await client.agentConversationFocus.updateMany({
      where: { id, version: current.version },
      data: {
        status: 'active',
        goal: ownerRequest.slice(0, 2000),
        kind: DIRECT_YOUTUBE_LANE_KIND,
        currentStep: 'open',
        blocker: null,
        lastErrorClass: null,
        nextActions: ['live_browser_status', 'live_browser_look', 'live_browser_act'],
        completionCriteria: 'Fresh server-verified YouTube playback proof',
        artifacts: { laneToken: token, ...invalidatedAskCardArtifacts(current, true) },
        leaseUntil,
        completedAt: null,
        version: current.version + 1,
      },
    })
    if (updated.count !== 1) continue
    await appendLaneEvent(
      { ...current, status: 'active', currentStep: 'open' },
      'resumed',
      current.status,
      'active',
      current.version + 1,
      client,
    )
    return { state: 'ready', ownerRequest, token }
  }
  throw new DirectYouTubeLaneStoreError('direct YouTube lane open lost repeated version races')
}

async function expireLane(
  row: DirectYouTubeLaneRow,
  now: Date,
  client: typeof db = db,
): Promise<void> {
  if (!(await supersedeExpectedAskCard(row, client))) return
  const updated = await client.agentConversationFocus.updateMany({
    where: { id: row.id, version: row.version },
    data: {
      status: 'abandoned',
      currentStep: 'expired',
      blocker: 'lane_lease_expired',
      artifacts: {
        laneToken: laneToken(row),
        ...durableDeviceArtifacts(row),
        ...invalidatedAskCardArtifacts(row, true),
      },
      leaseUntil: now,
      completedAt: now,
      version: row.version + 1,
    },
  })
  if (updated.count === 1) {
    await appendLaneEvent(row, 'abandoned', row.status, 'abandoned', row.version + 1, client)
  }
}

async function resumeDirectYouTubeLane(
  conversationId: string,
  token: string,
  now: Date,
  selectedOwnerReply?: string,
  selectedBinding?: DirectYouTubeDeviceOptionBinding,
  expectedRow?: {
    version: number
    laneToken: string
    expectedAskCardId: string
    currentStep: string | null
  },
): Promise<DirectYouTubeReadyTurnLane | null> {
  return db.$transaction(async (tx: typeof db) => {
    await lockDirectYouTubeLaneAuthority(tx, conversationId)
    await lockLiveBrowserDispatchAuthority(tx)
    const boundary = await readLiveBrowserDispatchBoundary(tx)
    const incomingTurn = await readRunningOwnerTurnAfterDispatchBoundary(
      conversationId,
      token,
      tx,
      boundary,
    )
    if (!incomingTurn) return null
    return resumeDirectYouTubeLaneLocked(
      conversationId,
      token,
      now,
      incomingTurn,
      boundary,
      tx,
      selectedOwnerReply,
      selectedBinding,
      expectedRow,
    )
  })
}

async function resumeDirectYouTubeLaneLocked(
  conversationId: string,
  token: string,
  now: Date,
  incomingTurn: OwnerTurnFence,
  boundary: LiveBrowserDispatchBoundary,
  client: typeof db,
  selectedOwnerReply?: string,
  selectedBinding?: DirectYouTubeDeviceOptionBinding,
  expectedRow?: {
    version: number
    laneToken: string
    expectedAskCardId: string
    currentStep: string | null
  },
): Promise<DirectYouTubeReadyTurnLane | null> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    if (!(await isRunningOwnerTurn(conversationId, token, client))) return null
    const row = await readLane(conversationId, client)
    if (!row) return null
    if (
      expectedRow
      && (
        row.version !== expectedRow.version
        || laneToken(row) !== expectedRow.laneToken
        || expectedAskCardId(row) !== expectedRow.expectedAskCardId
        || row.currentStep !== expectedRow.currentStep
      )
    ) return null
    const currentToken = laneToken(row)
    if (currentToken !== token) {
      const ownerInput = await import('./turn-owner-input')
      if (!await ownerInput.isTurnOwnerContinuationCurrent(
        conversationId,
        currentToken,
        token,
        client,
      )) return null
      const currentTurn = await readOwnerTurnFence(conversationId, currentToken, client)
      if (
        !currentTurn
        || !ownerTurnPassesDispatchBoundary(currentTurn, boundary)
        || currentTurn.startedAt.getTime() >= incomingTurn.startedAt.getTime()
      ) return null
    }
    if (!isOpenRow(row, now)) {
      if (
        row.kind === DIRECT_YOUTUBE_LANE_KIND
        && (row.status === 'active' || row.status === 'awaiting_owner')
        && (!row.leaseUntil || row.leaseUntil.getTime() <= now.getTime())
      ) {
        await expireLane(row, now, client).catch(() => {})
      }
      return null
    }
    const previousSelection = selectedDevice(row)
    const selection = selectedBinding
      ? {
          selectedOption: selectedBinding.option,
          deviceId: selectedBinding.deviceId,
          deviceName: selectedBinding.deviceName,
        }
      : previousSelection
    const snapshot = deviceOptions(row)
    const media = selectedMedia(row)
    if (!(await supersedeExpectedAskCard(row, client))) return null
    const updated = await client.agentConversationFocus.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        status: 'active',
        currentStep: 'continuing',
        blocker: null,
        artifacts: {
          laneToken: token,
          ...invalidatedAskCardArtifacts(row, true),
          ...(snapshot.length ? { deviceOptions: snapshot } : {}),
          ...(selectedOwnerReply ? { selectedOwnerReply } : {}),
          ...(media
            ? {
                selectedMediaVideoId: media.videoId,
                selectedMediaTitle: media.title,
                selectedMediaFingerprint: media.fingerprint,
              }
            : {}),
          ...(selection
            ? {
                selectedDeviceId: selection.deviceId,
                selectedDeviceName: selection.deviceName,
                selectedDeviceOption: selection.selectedOption,
              }
            : {}),
        },
        leaseUntil: boundedLease(now, DIRECT_YOUTUBE_LANE_ACTIVE_LEASE_MS),
        version: row.version + 1,
      },
    })
    if (updated.count !== 1) continue
    await appendLaneEvent(
      { ...row, currentStep: 'continuing' },
      'resumed',
      row.status,
      'active',
      row.version + 1,
      client,
    )
    return {
      state: 'ready',
      ownerRequest: row.goal,
      token,
      ...(selectedOwnerReply ? { selectedOwnerReply } : {}),
      ...(selection
        ? {
            selectedDeviceId: selection.deviceId,
            selectedDeviceName: selection.deviceName,
          }
        : {}),
    }
  }
  return null
}

async function closeLaneForNewOwnerTask(
  conversationId: string,
  incomingToken: string,
  now: Date,
): Promise<boolean> {
  return db.$transaction(async (tx: typeof db) => {
    await lockDirectYouTubeLaneAuthority(tx, conversationId)
    const incomingTurn = await readOwnerTurnFence(conversationId, incomingToken, tx)
    if (!incomingTurn || incomingTurn.status !== 'running' || incomingTurn.cancelRequested) return false
    return closeLaneForNewOwnerTaskLocked(conversationId, now, incomingTurn, tx)
  })
}

async function closeLaneForNewOwnerTaskLocked(
  conversationId: string,
  now: Date,
  incomingTurn: OwnerTurnFence,
  client: typeof db,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await readLane(conversationId, client)
    if (!row || row.kind !== DIRECT_YOUTUBE_LANE_KIND) return true
    if (row.status !== 'active' && row.status !== 'awaiting_owner') return true
    const currentTurn = await readOwnerTurnFence(conversationId, laneToken(row), client)
    if (
      !currentTurn
      || (
        currentTurn.id !== incomingTurn.id
        && currentTurn.startedAt.getTime() >= incomingTurn.startedAt.getTime()
      )
    ) return false
    if (!(await supersedeExpectedAskCard(row, client))) return false
    const updated = await client.agentConversationFocus.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        status: 'abandoned',
        currentStep: 'superseded_by_owner',
        blocker: 'owner_started_new_task',
        artifacts: {
          laneToken: laneToken(row),
          ...durableDeviceArtifacts(row),
          ...invalidatedAskCardArtifacts(row, true),
        },
        leaseUntil: now,
        completedAt: now,
        version: row.version + 1,
      },
    })
    if (updated.count !== 1) continue
    await appendLaneEvent(row, 'abandoned', row.status, 'abandoned', row.version + 1, client)
    return true
  }
  return false
}

export function isDirectBrowserContinuationText(text: string): boolean {
  return BROWSER_CONTINUATION.test(text.trim())
}

/**
 * Resolves only the latest owner message. History can never create continuity:
 * a short reply is accepted solely when the durable row is open and unexpired.
 * A fresh direct request is durably fenced before this function returns, which
 * means no caller can expose LOOK/ACT first and persist the lane afterwards.
 */
export async function resolveDirectYouTubeTurnRequest(
  conversationId: string,
  recentUserTexts: string[],
  turnToken: string = randomUUID(),
  replyContext?: { askCardId?: string | null; selectedOption?: string | null },
): Promise<DirectYouTubeTurnLane | null> {
  const latest = recentUserTexts[recentUserTexts.length - 1]?.trim() ?? ''
  if (!latest) return null
  const now = new Date()
  const suppliedReplyCardId = replyContext?.askCardId?.trim() ?? ''
  let observedRow: DirectYouTubeLaneRow | null = null

  // A card-bearing owner reply is authority-bearing input. If a direct lane
  // exists, only its exact current card while awaiting_owner may enter; an
  // unrelated card cannot re-token an open/continuing lane via generic text.
  if (suppliedReplyCardId) {
    try {
      observedRow = await readLane(conversationId)
    } catch {
      return { state: 'unavailable', ownerRequest: latest, token: null }
    }
    if (observedRow?.kind === DIRECT_YOUTUBE_LANE_KIND) {
      const rowIsOpen = isOpenRow(observedRow, now)
      const exactCurrentCard = Boolean(
        rowIsOpen
        && observedRow.currentStep === 'awaiting_owner'
        && expectedAskCardId(observedRow) === suppliedReplyCardId,
      )
      const historicalDirectCard = expectedAskCardId(observedRow) === suppliedReplyCardId
        || invalidatedAskCardIds(observedRow).includes(suppliedReplyCardId)
      if ((rowIsOpen && !exactCurrentCard) || (!rowIsOpen && historicalDirectCard)) {
        if (
          (observedRow.status === 'active' || observedRow.status === 'awaiting_owner')
          && (!observedRow.leaseUntil || observedRow.leaseUntil.getTime() <= now.getTime())
        ) {
          await expireLane(observedRow, now).catch(() => {})
        }
        return { state: 'unavailable', ownerRequest: latest, token: null }
      }
    }
  }

  if (isDirectYouTubeBrowserTask(latest)) {
    try {
      return await openDirectYouTubeLane(conversationId, latest, turnToken, now)
    } catch {
      // Tri-state fail-closed: callers keep a status-only direct lane. Without
      // a durable token, a new ask card would create a next-turn broad escape.
      // Callers must not reinterpret persistence outage as an ordinary broad-tool turn.
      return { state: 'unavailable', ownerRequest: latest, token: null }
    }
  }

  // Routing grammar is UX, never an authority boundary. Any YouTube mutation
  // wording that the strict direct classifier did not admit becomes a
  // status-only unavailable lane before either head can run deterministic
  // workflows, model tools, or an unproved success response.
  if (isPotentialYouTubeComputerUseMutation(latest)) {
    return {
      state: 'unavailable',
      ownerRequest: latest,
      token: null,
      blockerText: DIRECT_YOUTUBE_ROUTE_MISS_BLOCKER,
    }
  }

  // An awaiting-owner lane is resumed by the exact server-persisted ask-card
  // options as well as the small generic continuation vocabulary. Device names
  // are arbitrary owner data and must not be guessed by a finite regex.
  let awaitingRow: DirectYouTubeLaneRow | null = null
  try {
    observedRow = observedRow ?? await readLane(conversationId)
    if (observedRow && isOpenRow(observedRow, now) && observedRow.currentStep === 'awaiting_owner') {
      awaitingRow = observedRow
    }
  } catch {
    return { state: 'unavailable', ownerRequest: latest, token: null }
  }
  if (
    observedRow
    && isOpenRow(observedRow, now)
    && await persistedLaneTurnWasCanceled(observedRow)
  ) {
    return { state: 'unavailable', ownerRequest: latest, token: null }
  }
  if (awaitingRow) {
    if (BROWSER_CANCEL.test(latest)) {
      try {
        return await closeLaneForNewOwnerTask(conversationId, turnToken, now)
          ? null
          : { state: 'unavailable', ownerRequest: latest, token: null }
      } catch {
        return { state: 'unavailable', ownerRequest: latest, token: null }
      }
    }
    const requiredAskCardId = expectedAskCardId(awaitingRow)
    const suppliedAskCardId = suppliedReplyCardId
    const selectedOption = replyContext?.selectedOption?.trim() ?? latest
    const persistedDeviceOptions = deviceOptions(awaitingRow)
    const persistedDeviceSelection = selectedDevice(awaitingRow)
    if (requiredAskCardId) {
      if (
        suppliedAskCardId !== requiredAskCardId
        || selectedOption.toLocaleLowerCase() !== latest.toLocaleLowerCase()
        || !expectedOwnerReplyMatches(awaitingRow, selectedOption)
      ) {
        return { state: 'unavailable', ownerRequest: latest, token: null }
      }
      const selectedBinding = persistedDeviceOptions.find(
        (binding) => binding.option === selectedOption,
      )
      // Once a multi-device snapshot exists, only an exact option from that
      // exact card can resume authority. A model-written name/substring or a
      // different option on the same card is not a device selection.
      if (persistedDeviceOptions.length && !persistedDeviceSelection && !selectedBinding) {
        return { state: 'unavailable', ownerRequest: latest, token: null }
      }
      try {
        const resumed = await resumeDirectYouTubeLane(
          conversationId,
          turnToken,
          now,
          selectedOption,
          selectedBinding,
          {
            version: awaitingRow.version,
            laneToken: laneToken(awaitingRow),
            expectedAskCardId: requiredAskCardId,
            currentStep: awaitingRow.currentStep,
          },
        )
        return resumed ?? { state: 'unavailable', ownerRequest: latest, token: null }
      } catch {
        return { state: 'unavailable', ownerRequest: latest, token: null }
      }
    }
    // A tap on some other card must never satisfy a generic "yes/first" lane
    // continuation. Card-bearing replies require an exact persisted card id.
    if (suppliedAskCardId) {
      return { state: 'unavailable', ownerRequest: latest, token: null }
    }
    // A staged multi-device snapshot requires a persisted ask-card id. Generic
    // "continue", "second", or a model-supplied device substring cannot skip it.
    if (persistedDeviceOptions.length && !persistedDeviceSelection) {
      return { state: 'unavailable', ownerRequest: latest, token: null }
    }
    if (isDirectBrowserContinuationText(latest) || expectedOwnerReplyMatches(awaitingRow, latest)) {
      try {
        const resumed = await resumeDirectYouTubeLane(
          conversationId,
          turnToken,
          now,
          undefined,
          undefined,
          {
            version: awaitingRow.version,
            laneToken: laneToken(awaitingRow),
            expectedAskCardId: expectedAskCardId(awaitingRow),
            currentStep: awaitingRow.currentStep,
          },
        )
        return resumed ?? { state: 'unavailable', ownerRequest: latest, token: null }
      } catch {
        return { state: 'unavailable', ownerRequest: latest, token: null }
      }
    }
    // Do not widen an unmatched answer into the broad inventory. The owner can
    // choose a persisted option, explicitly cancel, or restate a new request.
    return { state: 'unavailable', ownerRequest: latest, token: null }
  }

  if (isDirectBrowserContinuationText(latest)) {
    // Read failures fail closed: a transcript word such as "continue" is never
    // enough to reactivate browser authority.
    try {
      const wasOpenDirectLane = Boolean(observedRow && isOpenRow(observedRow, now))
      const resumed = await resumeDirectYouTubeLane(
        conversationId,
        turnToken,
        now,
        undefined,
        undefined,
        observedRow && wasOpenDirectLane
          ? {
              version: observedRow.version,
              laneToken: laneToken(observedRow),
              expectedAskCardId: expectedAskCardId(observedRow),
              currentStep: observedRow.currentStep,
            }
          : undefined,
      )
      return resumed ?? (wasOpenDirectLane
        ? { state: 'unavailable', ownerRequest: latest, token: null }
        : null)
    } catch {
      return { state: 'unavailable', ownerRequest: latest, token: null }
    }
  }

  // A substantive new owner message revokes the old lane before normal routing.
  try {
    return await closeLaneForNewOwnerTask(conversationId, turnToken, now)
      ? null
      : { state: 'unavailable', ownerRequest: latest, token: null }
  } catch {
    return { state: 'unavailable', ownerRequest: latest, token: null }
  }
}

/**
 * Immediate execution fence for a ready lane. Selection-time authorization is
 * not enough: a newer owner turn may supersede this turn while its model is
 * still thinking. Every allowed tool call re-reads the durable token/lease.
 * Store errors fail closed.
 */
export async function isDirectYouTubeTurnLaneCurrent(
  conversationId: string,
  lane: DirectYouTubeTurnLane | null,
): Promise<boolean> {
  if (!lane || lane.state !== 'ready') return false
  return isDirectYouTubeTurnLaneTokenCurrent(conversationId, lane.token)
}

/** Registry-friendly form that never accepts model-authored owner text. */
export async function isDirectYouTubeTurnLaneTokenCurrent(
  conversationId: string,
  token: string,
): Promise<boolean> {
  if (!conversationId || !token) return false
  try {
    return await db.$transaction(async (tx: typeof db) => {
      await lockDirectYouTubeLaneAuthority(tx, conversationId)
      await lockLiveBrowserDispatchAuthority(tx)
      const ownerInput = await import('./turn-owner-input')
      if (!await ownerInput.isTurnOwnerExecutionCurrent(conversationId, token, tx)) return false
      const boundary = await readLiveBrowserDispatchBoundary(tx)
      if (!await readRunningOwnerTurnAfterDispatchBoundary(
        conversationId,
        token,
        tx,
        boundary,
      )) return false
      const row = await readLane(conversationId, tx)
      return Boolean(
        row
        && isOpenRow(row, new Date())
        && laneToken(row) === token,
      )
    })
  } catch {
    return false
  }
}

/** Linearization point for allowed direct-lane setup effects that do not travel
 * through the browser command bus (kill-switch and one-time pairing ticket).
 * The effect runs while holding the same conversation advisory lock used by
 * owner-message admission, so a newer owner instruction is ordered wholly
 * before (deny) or after (effect already completed), never between check/effect. */
export async function runDirectYouTubeOwnerFencedEffect<T>(input: {
  conversationId: string
  token: string
  effect: () => Promise<T>
}): Promise<{ authorized: true; value: T } | { authorized: false }> {
  const conversationId = input.conversationId.trim()
  const token = input.token.trim()
  if (!conversationId || !token) return { authorized: false }
  try {
    return await db.$transaction(async (tx: typeof db) => {
      await lockDirectYouTubeLaneAuthority(tx, conversationId)
      // Setup effects (currently pairing) do not travel through runCommand's
      // global dispatch fence. Take that same lock here so global Stop is
      // totally ordered with the final lane/turn check and the credential
      // effect. This SQL is kept local to avoid a turn-lane ↔ companion cycle.
      await lockLiveBrowserDispatchAuthority(tx)
      const ownerInput = await import('./turn-owner-input')
      if (!await ownerInput.isTurnOwnerExecutionCurrent(conversationId, token, tx)) {
        return { authorized: false } as const
      }
      const [boundary, enabledRow] = await Promise.all([
        readLiveBrowserDispatchBoundary(tx),
        tx.agentKvSetting.findUnique({
          where: { key: LIVE_BROWSER_ENABLED_KEY },
          select: { value: true },
        }),
      ])
      const turn = await readRunningOwnerTurnAfterDispatchBoundary(
        conversationId,
        token,
        tx,
        boundary,
      )
      if (
        !turn
        || enabledRow?.value !== 'true'
      ) return { authorized: false } as const
      const row = await readLane(conversationId, tx)
      if (!row || !isOpenRow(row, new Date()) || laneToken(row) !== token) {
        return { authorized: false } as const
      }
      return { authorized: true, value: await input.effect() } as const
    })
  } catch {
    return { authorized: false }
  }
}

function askCardIdForOwnerMessage(conversationId: string, userMessageId: string): string {
  return `ask_${createHash('sha256')
    .update(`${conversationId}:${userMessageId}`)
    .digest('hex').slice(0, 32)}`
}

/**
 * Reserve the deterministic card identity before ask_user creates its row.
 * This closes the create → bind gap: even if the post-create bind and card
 * cleanup both fail, terminal/expiry/resume transitions still know the exact
 * direct-lane card and cannot later admit it as an unrelated broad-task card.
 */
export async function reserveDirectYouTubeAskCard(input: {
  conversationId: string
  token: string
}): Promise<{ askCardId: string } | null> {
  const conversationId = input.conversationId.trim()
  const token = input.token.trim()
  if (!conversationId || !token) return null

  return db.$transaction(async (tx: typeof db) => {
    await lockDirectYouTubeLaneAuthority(tx, conversationId)
    await lockLiveBrowserDispatchAuthority(tx)
    const ownerInput = await import('./turn-owner-input')
    if (!await ownerInput.isTurnOwnerExecutionCurrent(conversationId, token, tx)) return null
    const boundary = await readLiveBrowserDispatchBoundary(tx)
    const turn = await readRunningOwnerTurnAfterDispatchBoundary(
      conversationId,
      token,
      tx,
      boundary,
    )
    const userMessageId = typeof turn?.userMessageId === 'string'
      ? turn.userMessageId.trim()
      : ''
    if (!turn || !userMessageId) return null
    const askCardId = askCardIdForOwnerMessage(conversationId, userMessageId)
    const now = new Date()

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const row = await readLane(conversationId, tx)
      if (!row || !isOpenRow(row, now) || laneToken(row) !== token) return null
      if (invalidatedAskCardIds(row).includes(askCardId)) return null
      const previousAskCardId = expectedAskCardId(row)
      if (previousAskCardId) {
        return previousAskCardId === askCardId ? { askCardId } : null
      }
      const updated = await tx.agentConversationFocus.updateMany({
        where: { id: row.id, version: row.version },
        data: {
          artifacts: {
            ...(row.artifacts ?? {}),
            laneToken: token,
            expectedAskCardId: askCardId,
          },
          version: row.version + 1,
        },
      })
      if (updated.count !== 1) continue
      await appendLaneEvent(row, 'ask_card_reserved', row.status, row.status, row.version + 1, tx)
      return { askCardId }
    }
    return null
  }).catch(() => null)
}

/**
 * Bind a newly persisted direct-lane ask card immediately, before turn-end
 * settlement. The same CAS also moves the lane to awaiting_owner so the exact
 * card is authoritative as soon as its successful tool result can reach the UI.
 * Turn-end settlement remains an idempotent confirmation of this transition.
 */
export async function bindDirectYouTubeAskCard(input: {
  conversationId: string
  token: string
  askCardId: string
  options: string[]
}): Promise<boolean> {
  const conversationId = input.conversationId.trim()
  const token = input.token.trim()
  const askCardId = input.askCardId.trim()
  const options = input.options.map((option) => option.trim())
  const validOptions = options.length > 0
    && options.length <= 24
    && options.every(Boolean)
    && new Set(options).size === options.length
  const rejectNewCard = async (): Promise<false> => {
    if (conversationId && askCardId) {
      await supersedeDirectYouTubeAskCards(conversationId, [askCardId])
    }
    return false
  }
  if (!conversationId || !token || !askCardId || !validOptions) return rejectNewCard()

  try {
    return await db.$transaction(async (tx: typeof db) => {
      await lockDirectYouTubeLaneAuthority(tx, conversationId)
      await lockLiveBrowserDispatchAuthority(tx)
      const rejectWith = async (): Promise<false> => {
        await supersedeDirectYouTubeAskCardsWith(tx, conversationId, [askCardId])
        return false
      }
      const ownerInput = await import('./turn-owner-input')
      if (!await ownerInput.isTurnOwnerExecutionCurrent(conversationId, token, tx)) {
        return rejectWith()
      }
      const boundary = await readLiveBrowserDispatchBoundary(tx)
      if (!await readRunningOwnerTurnAfterDispatchBoundary(
        conversationId,
        token,
        tx,
        boundary,
      )) return rejectWith()

      const now = new Date()
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        const row = await readLane(conversationId, tx)
        if (!row || !isOpenRow(row, now) || laneToken(row) !== token) return rejectWith()
        if (invalidatedAskCardIds(row).includes(askCardId)) return rejectWith()

        const previousAskCardId = expectedAskCardId(row)
        const previousExpectedOptions = row.artifacts?.expectedOwnerReplies
        const previousOptions = Array.isArray(previousExpectedOptions)
          ? previousExpectedOptions.filter((value): value is string => typeof value === 'string')
          : []
        const exactAlreadyBound = (
          previousAskCardId === askCardId
          && previousOptions.length === options.length
          && previousOptions.every((option, index) => option === options[index])
        )
        if (
          exactAlreadyBound
          && row.status === 'awaiting_owner'
          && row.currentStep === 'awaiting_owner'
        ) return true
        if (row.currentStep === 'awaiting_owner' && previousAskCardId !== askCardId) {
          return rejectWith()
        }

        const snapshot = deviceOptions(row)
        if (snapshot.length && !selectedDevice(row)) {
          const required = new Set(snapshot.map((binding) => binding.option))
          if (options.length !== required.size || !options.every((option) => required.has(option))) {
            return rejectWith()
          }
        }
        if (
          previousAskCardId
          && previousAskCardId !== askCardId
          && !(await supersedeDirectYouTubeAskCardsWith(tx, conversationId, [previousAskCardId]))
        ) {
          return rejectWith()
        }

        const updated = await tx.agentConversationFocus.updateMany({
          where: { id: row.id, version: row.version },
          data: {
            status: 'awaiting_owner',
            currentStep: 'awaiting_owner',
            artifacts: {
              ...(row.artifacts ?? {}),
              laneToken: token,
              expectedOwnerReplies: options,
              expectedAskCardId: askCardId,
            },
            leaseUntil: boundedLease(now, DIRECT_YOUTUBE_LANE_MAX_LEASE_MS),
            version: row.version + 1,
          },
        })
        if (updated.count !== 1) continue
        await appendLaneEvent(
          { ...row, currentStep: 'awaiting_owner' },
          'ask_card_bound',
          row.status,
          'awaiting_owner',
          row.version + 1,
          tx,
        )
        return true
      }
      return rejectWith()
    })
  } catch {
    return rejectNewCard()
  }
}

/**
 * Persist the exact online-device choices before the model can render a card.
 * The option text is server-generated and maps to one immutable owner-scoped
 * device id. Reordering the live device list cannot change an existing card.
 */
export async function stageDirectYouTubeDeviceOptions(input: {
  conversationId: string
  token: string
  devices: Array<{ deviceId: string; deviceName: string }>
}): Promise<DirectYouTubeDeviceSelection> {
  if (input.devices.length < 2) return { state: 'unavailable' }
  const snapshot = buildDeviceOptionSnapshot(input.devices)
  if (!input.conversationId || !input.token || !snapshot) return { state: 'unavailable' }
  const now = new Date()
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    let row: DirectYouTubeLaneRow | null
    try {
      row = await readLane(input.conversationId)
    } catch {
      return { state: 'unavailable' }
    }
    if (!row || !isOpenRow(row, now) || laneToken(row) !== input.token) {
      return { state: 'unavailable' }
    }
    const selected = selectedDevice(row)
    if (selected) {
      return {
        state: 'selected',
        selectedOption: selected.selectedOption,
        deviceId: selected.deviceId,
        deviceName: selected.deviceName,
      }
    }
    const current = deviceOptions(row)
    if (current.length && sameDeviceSnapshot(current, snapshot)) {
      return { state: 'required', options: current }
    }
    // Once the ask-card turn is closed, its snapshot is immutable. A heartbeat,
    // rename, repair, or reorder after emission must fail, never rewrite what an
    // already-visible option means.
    if (row.currentStep === 'awaiting_owner') return { state: 'unavailable' }
    const updated = await db.agentConversationFocus.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        artifacts: {
          ...(row.artifacts ?? {}),
          laneToken: input.token,
          deviceOptions: snapshot,
        },
        version: row.version + 1,
      },
    }).catch(() => ({ count: 0 }))
    if (updated.count !== 1) continue
    await appendLaneEvent(row, 'device_options_staged', row.status, row.status, row.version + 1)
    return { state: 'required', options: snapshot }
  }
  return { state: 'unavailable' }
}

/** Bind the only online choice once; later LOOKs must keep this exact id/name. */
export async function bindDirectYouTubeSoleDevice(input: {
  conversationId: string
  token: string
  device: { deviceId: string; deviceName: string }
}): Promise<DirectYouTubeDeviceSelection> {
  const snapshot = buildDeviceOptionSnapshot([input.device])
  if (!input.conversationId || !input.token || !snapshot) return { state: 'unavailable' }
  const binding = snapshot[0]
  const now = new Date()
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    let row: DirectYouTubeLaneRow | null
    try {
      row = await readLane(input.conversationId)
    } catch {
      return { state: 'unavailable' }
    }
    if (!row || !isOpenRow(row, now) || laneToken(row) !== input.token) {
      return { state: 'unavailable' }
    }
    const selected = selectedDevice(row)
    if (selected) {
      return {
        state: 'selected',
        selectedOption: selected.selectedOption,
        deviceId: selected.deviceId,
        deviceName: selected.deviceName,
      }
    }
    // A prior multi-device snapshot remains a required owner choice even if
    // all but one devices disappear before the card is answered.
    const current = deviceOptions(row)
    if (current.length) return { state: 'required', options: current }
    if (row.currentStep === 'awaiting_owner') return { state: 'unavailable' }
    const updated = await db.agentConversationFocus.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        artifacts: {
          ...(row.artifacts ?? {}),
          laneToken: input.token,
          deviceOptions: snapshot,
          selectedDeviceId: binding.deviceId,
          selectedDeviceName: binding.deviceName,
          selectedDeviceOption: binding.option,
        },
        version: row.version + 1,
      },
    }).catch(() => ({ count: 0 }))
    if (updated.count !== 1) continue
    await appendLaneEvent(row, 'sole_device_bound', row.status, row.status, row.version + 1)
    return {
      state: 'selected',
      selectedOption: binding.option,
      deviceId: binding.deviceId,
      deviceName: binding.deviceName,
    }
  }
  return { state: 'unavailable' }
}

/** Same durable exact-id binder after the server resolves an explicit owner target. */
export async function bindDirectYouTubeOwnerTarget(input: {
  conversationId: string
  token: string
  device: { deviceId: string; deviceName: string }
}): Promise<DirectYouTubeDeviceSelection> {
  return bindDirectYouTubeSoleDevice(input)
}

/** Server-side LOOK resolver; it never trusts model-authored display names. */
export async function getDirectYouTubeDeviceSelection(
  conversationId: string,
  token: string,
): Promise<DirectYouTubeDeviceSelection> {
  if (!conversationId || !token) return { state: 'unavailable' }
  try {
    const row = await readLane(conversationId)
    if (!row || !isOpenRow(row, new Date()) || laneToken(row) !== token) {
      return { state: 'unavailable' }
    }
    const selected = selectedDevice(row)
    if (selected) {
      return {
        state: 'selected',
        selectedOption: selected.selectedOption,
        deviceId: selected.deviceId,
        deviceName: selected.deviceName,
      }
    }
    const snapshot = deviceOptions(row)
    if (snapshot.length) return { state: 'required', options: snapshot }
    // An invalid non-empty persisted snapshot is an integrity failure, not
    // permission to fall back to a current name lookup.
    if (row.artifacts?.deviceOptions !== undefined) return { state: 'unavailable' }
    return { state: 'none' }
  } catch {
    return { state: 'unavailable' }
  }
}

/** Bind the exact observed YouTube result before its click can dispatch. */
export async function bindDirectYouTubeSelectedMedia(input: {
  conversationId: string
  token: string
  videoId: string
  title: string
  fingerprint: string
}): Promise<boolean> {
  const conversationId = input.conversationId.trim()
  const token = input.token.trim()
  const media: DirectYouTubeSelectedMediaIdentity = {
    videoId: input.videoId.trim(),
    title: input.title.trim().slice(0, 500),
    fingerprint: input.fingerprint.trim().slice(0, 2000),
  }
  if (
    !conversationId
    || !token
    || !/^[A-Za-z0-9_-]{11}$/.test(media.videoId)
    || !media.title
    || !media.fingerprint
  ) return false
  const now = new Date()
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    let row: DirectYouTubeLaneRow | null
    try {
      row = await readLane(conversationId)
    } catch {
      return false
    }
    if (!row || !isOpenRow(row, now) || laneToken(row) !== token) return false
    const existing = selectedMedia(row)
    if (existing) {
      return existing.videoId === media.videoId
        && existing.title === media.title
        && existing.fingerprint === media.fingerprint
    }
    if (
      row.artifacts?.selectedMediaVideoId !== undefined
      || row.artifacts?.selectedMediaTitle !== undefined
      || row.artifacts?.selectedMediaFingerprint !== undefined
    ) return false
    const updated = await db.agentConversationFocus.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        artifacts: {
          ...(row.artifacts ?? {}),
          laneToken: token,
          selectedMediaVideoId: media.videoId,
          selectedMediaTitle: media.title,
          selectedMediaFingerprint: media.fingerprint,
        },
        version: row.version + 1,
      },
    }).catch(() => ({ count: 0 }))
    if (updated.count !== 1) continue
    await appendLaneEvent(row, 'selected_media_bound', row.status, row.status, row.version + 1)
    return true
  }
  return false
}

export async function getDirectYouTubeSelectedMedia(
  conversationId: string,
  token: string,
): Promise<DirectYouTubeSelectedMediaState> {
  if (!conversationId || !token) return { state: 'unavailable' }
  try {
    const row = await readLane(conversationId)
    if (!row || !isOpenRow(row, new Date()) || laneToken(row) !== token) {
      return { state: 'unavailable' }
    }
    const media = selectedMedia(row)
    if (media) return { state: 'selected', ...media }
    if (
      row.artifacts?.selectedMediaVideoId !== undefined
      || row.artifacts?.selectedMediaTitle !== undefined
      || row.artifacts?.selectedMediaFingerprint !== undefined
    ) return { state: 'unavailable' }
    return { state: 'none' }
  } catch {
    return { state: 'unavailable' }
  }
}

/** Revoke the exact in-flight lane when a new owner steering message arrives. */
export async function revokeDirectYouTubeTurnLaneForSteering(
  conversationId: string,
  token: string,
): Promise<boolean> {
  const now = new Date()
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    let row: DirectYouTubeLaneRow | null
    try {
      row = await readLane(conversationId)
    } catch {
      return false
    }
    if (!row || row.kind !== DIRECT_YOUTUBE_LANE_KIND || laneToken(row) !== token) return false
    if (row.status !== 'active' && row.status !== 'awaiting_owner') return false
    if (!(await supersedeExpectedAskCard(row))) return false
    const updated = await db.agentConversationFocus.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        status: 'abandoned',
        currentStep: 'steered_by_owner',
        blocker: 'owner_steering_revoked_lane',
        artifacts: {
          laneToken: token,
          ...durableDeviceArtifacts(row),
          ...invalidatedAskCardArtifacts(row, true),
        },
        leaseUntil: now,
        completedAt: now,
        version: row.version + 1,
      },
    }).catch(() => ({ count: 0 }))
    if (updated.count !== 1) continue
    await appendLaneEvent(row, 'abandoned', row.status, 'abandoned', row.version + 1)
    return true
  }
  return false
}

/** Settle the exact turn that opened/resumed the lane. Stale tokens are no-ops. */
export async function settleDirectYouTubeTurnLane(input: {
  conversationId: string
  token: string
  outcome: DirectYouTubeLaneOutcome
  /** Exact server-emitted ask-card choices that may resume awaiting_owner. */
  expectedOwnerReplies?: string[]
  expectedAskCardId?: string
}): Promise<boolean> {
  const conversationId = input.conversationId.trim()
  const token = input.token.trim()
  if (!conversationId || !token) return false
  const terminal = input.outcome === 'completed' || input.outcome === 'terminal_blocker'
  return db.$transaction(async (tx: typeof db) => {
    await lockDirectYouTubeLaneAuthority(tx, conversationId)
    await lockLiveBrowserDispatchAuthority(tx)
    if (!terminal) {
      const boundary = await readLiveBrowserDispatchBoundary(tx)
      if (!await readRunningOwnerTurnAfterDispatchBoundary(
        conversationId,
        token,
        tx,
        boundary,
      )) {
        const cardId = input.expectedAskCardId?.trim()
        if (cardId) await supersedeDirectYouTubeAskCardsWith(tx, conversationId, [cardId])
        return false
      }
    }

    const now = new Date()
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const row = await readLane(conversationId, tx).catch(() => null)
      if (!row || row.kind !== DIRECT_YOUTUBE_LANE_KIND || laneToken(row) !== token) return false
      if (row.status !== 'active' && row.status !== 'awaiting_owner') return false

      if (terminal && !(await supersedeExpectedAskCard(row, tx))) return false
      const status = input.outcome === 'completed'
        ? 'done'
        : input.outcome === 'terminal_blocker'
          ? 'abandoned'
          : input.outcome === 'awaiting_owner'
            ? 'awaiting_owner'
            : 'active'
      const currentStep: OpenLaneStep | 'completed' | 'terminal_blocker' = input.outcome
      const expectedOwnerReplies = [...new Set((input.expectedOwnerReplies ?? [])
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 24))]
      const expectedAskCard = input.expectedAskCardId?.trim()
      const stagedDeviceOptions = deviceOptions(row)
      const stagedDeviceSelection = selectedDevice(row)
      if (input.outcome === 'awaiting_owner' && stagedDeviceOptions.length && !stagedDeviceSelection) {
        const requiredOptions = new Set(stagedDeviceOptions.map((binding) => binding.option))
        const exactCompleteSnapshot = Boolean(expectedAskCard)
          && expectedOwnerReplies.length === requiredOptions.size
          && expectedOwnerReplies.every((option) => requiredOptions.has(option))
        if (!exactCompleteSnapshot) {
          if (expectedAskCard) {
            await supersedeDirectYouTubeAskCardsWith(tx, conversationId, [expectedAskCard])
          }
          return false
        }
      }
      const leaseMs = input.outcome === 'awaiting_owner'
        ? DIRECT_YOUTUBE_LANE_MAX_LEASE_MS
        : DIRECT_YOUTUBE_LANE_ACTIVE_LEASE_MS
      const preservedDeviceArtifacts = durableDeviceArtifacts(row)
      const updated = await tx.agentConversationFocus.updateMany({
        where: { id: row.id, version: row.version },
        data: {
          status,
          currentStep,
          blocker: input.outcome === 'terminal_blocker' ? 'playback_verification_failed' : null,
          artifacts: input.outcome === 'awaiting_owner'
            ? {
                laneToken: token,
                ...preservedDeviceArtifacts,
                ...(expectedOwnerReplies.length ? { expectedOwnerReplies } : {}),
                ...(expectedAskCard ? { expectedAskCardId: expectedAskCard } : {}),
              }
            : terminal
              ? {
                  laneToken: token,
                  ...invalidatedAskCardArtifacts(row, true),
                }
              : { laneToken: token, ...preservedDeviceArtifacts },
          leaseUntil: terminal ? now : boundedLease(now, leaseMs),
          completedAt: terminal ? now : null,
          version: row.version + 1,
        },
      }).catch(() => ({ count: 0 }))
      if (updated.count !== 1) continue
      await appendLaneEvent(
        { ...row, currentStep },
        input.outcome === 'completed'
          ? 'completed'
          : input.outcome === 'terminal_blocker'
            ? 'blocked'
            : input.outcome === 'awaiting_owner'
              ? 'awaiting_owner'
              : 'updated',
        row.status,
        status,
        row.version + 1,
        tx,
      )
      return true
    }
    return false
  }).catch(() => false)
}
