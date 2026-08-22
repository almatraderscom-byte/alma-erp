/**
 * Phase E (live browser companion) — server-side command bus.
 *
 * Goal: let the agent operate the OWNER'S OWN Chrome (his real, logged-in tabs) and
 * have the owner watch it happen live — without the agent ever touching credentials.
 *
 * Shape:
 *   • A tiny Chrome MV3 extension ("ALMA Companion") runs in the owner's Mac Chrome.
 *     It pairs once with a one-time code → receives a bearer token. From then on it
 *     LONG-POLLS this server for commands and posts back results + screenshots.
 *   • This module is the durable command bus (Postgres, per the "never in-memory"
 *     rule): the agent ENQUEUES a command and AWAITS its result; the extension is the
 *     only thing that executes, inside the owner's active logged-in tab.
 *
 * Safety model (defence in depth):
 *   • KV kill-switch `live_browser_enabled` (default OFF) — capability is opt-in.
 *   • Pairing token is sha256-HASHED in the DB; the raw token only ever lives in the
 *     owner's browser. Auth = constant-time hash compare.
 *   • The extension whitelists verbs; THIS side additionally treats every command as
 *     non-destructive automation. Anything money / irreversible stays the owner's
 *     own last click — the agent reads + fills + navigates, it does not auto-confirm.
 *   • Local kill switch in the popup (`paused`) means nothing runs even if queued.
 */
import { createHash, timingSafeEqual, randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  directYouTubeLaneIdForConversation,
  lockDirectYouTubeLaneAuthority,
} from './turn-lane'
import { isTurnOwnerExecutionCurrent } from './turn-owner-input'

/** KV kill-switch (owner-tunable, no redeploy). Default OFF — capability is opt-in. */
export const LIVE_BROWSER_ENABLED_KEY = 'live_browser_enabled'
/** Old turns at/before this durable STOP boundary can never dispatch after Resume. */
export const LIVE_BROWSER_DISPATCH_NOT_BEFORE_KEY = 'live_browser_dispatch_not_before'
/**
 * Dispatch protocol that proves a Companion performs the server-side
 * delivered -> executing authorization handshake immediately before page code.
 * Older companions must remain connected but may never receive a command.
 */
export const LIVE_BROWSER_AUTHORIZE_PROTOCOL = 'authorize-v1'

export function supportsLiveBrowserAuthorizeProtocol(protocol: string | null | undefined): boolean {
  return protocol?.trim() === LIVE_BROWSER_AUTHORIZE_PROTOCOL
}

async function lockLiveBrowserDispatchAuthority(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended('alma_live_browser_dispatch_global', 0)
    )::text AS lock_token /* live_browser_dispatch_global */
  `)
}

async function liveBrowserEnabledFrom(client: Pick<Prisma.TransactionClient, 'agentKvSetting'>): Promise<boolean> {
  const row = await client.agentKvSetting.findUnique({
    where: { key: LIVE_BROWSER_ENABLED_KEY },
    select: { value: true },
  })
  return row?.value === 'true'
}

async function liveBrowserDispatchNotBeforeFrom(
  client: Pick<Prisma.TransactionClient, 'agentKvSetting'>,
): Promise<Date | null> {
  const row = await client.agentKvSetting.findUnique({
    where: { key: LIVE_BROWSER_DISPATCH_NOT_BEFORE_KEY },
    select: { value: true },
  })
  const timestamp = Date.parse(row?.value ?? '')
  return Number.isFinite(timestamp) ? new Date(timestamp) : null
}

function turnStartedAfterDispatchBoundary(startedAt: Date, boundary: Date | null): boolean {
  return !boundary || startedAt.getTime() > boundary.getTime()
}

/** Command verbs the extension knows how to run. Mirrors background.js ALLOWED_ACTIONS. */
export const LIVE_BROWSER_ACTIONS = [
  'ping',
  'get_identity',
  'navigate',
  'read_text',
  'read_dom',
  'click',
  'type',
  'press',
  'select_option',
  'pick_option',
  'upload_file',
  'hover',
  'scroll',
  'scroll_to',
  'wait',
  'screenshot',
  'go_back',
  'switch_tab',
  'close_tab',
] as const
export type LiveBrowserAction = (typeof LIVE_BROWSER_ACTIONS)[number]

/** Verbs that change page state (vs. pure read). Used for audit / future gating. */
const WRITE_ACTIONS = new Set<LiveBrowserAction>([
  'click',
  'type',
  'press',
  'select_option',
  'pick_option',
  'upload_file',
  'navigate',
  'go_back',
  'switch_tab',
  'close_tab',
])

// A delivered command may have executed even when its result never reached the
// server (MV3 worker crash between page effect and durable outbox write). Only
// observational/idempotent actions may be lease-retried; everything else is
// terminal-unknown and requires a fresh LOOK. Positive allowlist keeps future
// verbs fail-closed by default.
const REPLAY_SAFE_DELIVERED_ACTIONS = new Set<LiveBrowserAction>([
  'ping',
  'get_identity',
  'read_text',
  'read_dom',
  'wait',
  'screenshot',
])

const COMMAND_DEFAULT_TIMEOUT_MS = 90_000
const COMMAND_POLL_INTERVAL_MS = 700
/** Longer than the extension's 35s whole-command ceiling, so live work is never reclaimed. */
export const BROWSER_DELIVERY_LEASE_MS = 40_000
const MAX_BROWSER_DELIVERY_ATTEMPTS = 3
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000 // a one-time code is valid for 10 minutes
const DEVICE_OFFLINE_MS = 90_000 // no poll in 90s ⇒ treat the companion as offline
export const BROWSER_PREVIEW_LEASE_TTL_MS = 25_000
/** Private durable metadata. Removed before params are returned to the Companion. */
const DIRECT_BROWSER_LANE_TOKEN_PARAM = '__almaDirectBrowserLaneToken'

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

/** Reads the live-browser kill-switch (KV). Default OFF. */
export async function isLiveBrowserEnabled(): Promise<boolean> {
  try {
    return await liveBrowserEnabledFrom(prisma)
  } catch {
    return false
  }
}

async function writeLiveBrowserDispatchState(
  tx: Prisma.TransactionClient,
  enabled: boolean,
  stopError: string,
): Promise<{
  stoppedQueuedOrDelivered: number
  executing: number
  affectedTurnContexts: Array<{ turnId: string; conversationId: string }>
}> {
  const value = enabled ? 'true' : 'false'
  await tx.agentKvSetting.upsert({
    where: { key: LIVE_BROWSER_ENABLED_KEY },
    create: { key: LIVE_BROWSER_ENABLED_KEY, value },
    update: { value },
  })
  if (enabled) {
    return { stoppedQueuedOrDelivered: 0, executing: 0, affectedTurnContexts: [] }
  }

  const boundaryClock = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now" /* live_browser_stop_boundary_clock */
  `)
  const stopBoundary = boundaryClock[0]?.now
  if (!(stopBoundary instanceof Date) || !Number.isFinite(stopBoundary.getTime())) {
    throw new Error('live_browser_stop_boundary_clock_unavailable')
  }
  await tx.agentKvSetting.upsert({
    where: { key: LIVE_BROWSER_DISPATCH_NOT_BEFORE_KEY },
    create: {
      key: LIVE_BROWSER_DISPATCH_NOT_BEFORE_KEY,
      value: stopBoundary.toISOString(),
    },
    update: { value: stopBoundary.toISOString() },
  })

  // The flag is global, so OFF must sweep the global queue. Restricting this to
  // the devices visible to one request would let an older queued command wake
  // up after a later ON transition.
  const affectedRows = await tx.liveBrowserCommand.findMany({
    where: { status: { in: ['queued', 'delivered', 'executing'] } },
    select: { turnId: true, conversationId: true },
  })
  const stopped = await tx.liveBrowserCommand.updateMany({
    where: { status: { in: ['queued', 'delivered'] } },
    data: { status: 'failed', error: stopError, resolvedAt: new Date() },
  })
  const executing = await tx.liveBrowserCommand.count({ where: { status: 'executing' } })
  const affectedTurnContexts = Array.from(new Map(affectedRows.flatMap((row) => (
    row.turnId && row.conversationId
      ? [[`${row.conversationId}\u0000${row.turnId}`, {
          turnId: row.turnId,
          conversationId: row.conversationId,
        }] as const]
      : []
  ))).values())
  return { stoppedQueuedOrDelivered: stopped.count, executing, affectedTurnContexts }
}

async function disableLiveBrowserDispatch(stopError: string): Promise<{
  stoppedQueuedOrDelivered: number
  executing: number
}> {
  // Reconcile commands whose effect window has already elapsed before counting
  // in-flight work. This path is owner/server driven and does not depend on the
  // Companion ever polling again after an MV3 crash or lost result.
  const [reconciled, activeDirectLanes] = await Promise.all([
    reconcileStaleBrowserExecutionsDetailed(),
    prisma.agentConversationFocus.findMany({
      where: {
        kind: 'direct_youtube_browser',
        status: { in: ['active', 'awaiting_owner'] },
      },
      select: { conversationId: true, artifacts: true },
    }),
  ])
  const stopped = await prisma.$transaction(async (tx) => {
    await lockLiveBrowserDispatchAuthority(tx)
    return writeLiveBrowserDispatchState(tx, false, stopError)
  })

  const contexts = Array.from(new Map([
    ...reconciled.turnContexts,
    ...stopped.affectedTurnContexts,
    ...activeDirectLanes.flatMap((lane) => {
      const artifacts = lane.artifacts && typeof lane.artifacts === 'object'
        && !Array.isArray(lane.artifacts)
        ? lane.artifacts as Record<string, unknown>
        : {}
      const turnId = typeof artifacts.laneToken === 'string'
        ? artifacts.laneToken.trim()
        : ''
      return turnId ? [{ turnId, conversationId: lane.conversationId }] : []
    }),
  ].map((context) => [
    `${context.conversationId}\u0000${context.turnId}`,
    context,
  ])).values()).sort((a, b) => (
    a.conversationId.localeCompare(b.conversationId) || a.turnId.localeCompare(b.turnId)
  ))
  // Global STOP is also a durable revocation boundary for the turns that owned
  // affected commands. Otherwise Resume could let an old still-running lane
  // enqueue a brand-new effect after STOP had been acknowledged.
  for (const context of contexts) {
    await cancelLiveBrowserTurn(context.turnId)
  }

  // OFF prevents new authorization, so this post-cancel count can only stay the
  // same or decrease. It is the truthful `stopping` witness for the caller.
  const executing = await prisma.liveBrowserCommand.count({ where: { status: 'executing' } })
  return { stoppedQueuedOrDelivered: stopped.stoppedQueuedOrDelivered, executing }
}

/** Flip the kill-switch. OFF also terminalizes every not-yet-authorized command. */
export async function setLiveBrowserEnabled(enabled: boolean): Promise<boolean> {
  if (enabled) {
    await prisma.$transaction(async (tx) => {
      await lockLiveBrowserDispatchAuthority(tx)
      await writeLiveBrowserDispatchState(tx, true, 'live_browser_disabled_before_execution')
    })
  } else {
    await disableLiveBrowserDispatch('live_browser_disabled_before_execution')
  }
  return enabled
}

export async function stopAllLiveBrowserDispatches(_deviceIds: string[]): Promise<{
  stoppedQueuedOrDelivered: number
  executing: number
}> {
  return disableLiveBrowserDispatch('owner_stop (watch panel)')
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Constant-time compare of two hex hashes. */
function hashesEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex')
    const bb = Buffer.from(b, 'hex')
    if (ba.length !== bb.length || ba.length === 0) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

/** A short, human-typeable one-time pairing code, e.g. "4F9K-2T7Q". */
function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1 ambiguity
  const pick = (n: number) =>
    Array.from(randomBytes(n))
      .map((b) => alphabet[b % alphabet.length])
      .join('')
  return `${pick(4)}-${pick(4)}`
}

// ---------------------------------------------------------------------------
// Owner resolution (mirrors native-owner-push.ts)
// ---------------------------------------------------------------------------

/** Resolve the single owner ERP user id devices belong to. Returns null if none. */
export async function resolveOwnerUserId(): Promise<string | null> {
  try {
    const { resolveOwnerUserIds } = await import('@/agent/lib/native-owner-push')
    const ids = await resolveOwnerUserIds()
    return ids[0] ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pairing (owner-initiated)
// ---------------------------------------------------------------------------

export interface PairingTicket {
  deviceId: string
  code: string
  expiresAt: Date
  deviceName: string
}

/**
 * Create a one-time pairing code the owner types into the extension. The device row
 * is created in an UNpaired state (no tokenHash yet); pairing completes when the
 * extension redeems the code via `redeemPairingCode`.
 */
export async function createPairingTicket(deviceName?: string): Promise<PairingTicket> {
  const ownerUserId = await resolveOwnerUserId()
  if (!ownerUserId) throw new Error('owner_user_unresolved')

  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS)
  const name = (deviceName ?? '').trim() || 'My Chrome'

  const device = await prisma.liveBrowserDevice.create({
    data: { ownerUserId, name, pairingCode: code, pairingExp: expiresAt },
    select: { id: true },
  })

  return { deviceId: device.id, code, expiresAt, deviceName: name }
}

export interface RedeemResult {
  ok: boolean
  token?: string
  deviceId?: string
  error?: string
}

/**
 * Extension redeems a pairing code → receives a bearer token. The raw token is
 * returned ONCE (only ever stored hashed). Re-pairing rotates the token.
 */
export async function redeemPairingCode(code: string, deviceName?: string): Promise<RedeemResult> {
  const trimmed = (code ?? '').trim().toUpperCase()
  if (!trimmed) return { ok: false, error: 'code_required' }

  const device = await prisma.liveBrowserDevice.findUnique({
    where: { pairingCode: trimmed },
    select: { id: true, pairingExp: true, revoked: true },
  })
  if (!device) return { ok: false, error: 'invalid_code' }
  if (device.revoked) return { ok: false, error: 'device_revoked' }
  if (!device.pairingExp || device.pairingExp.getTime() < Date.now()) {
    return { ok: false, error: 'code_expired' }
  }

  const rawToken = randomBytes(32).toString('hex')
  const name = (deviceName ?? '').trim()

  await prisma.liveBrowserDevice.update({
    where: { id: device.id },
    data: {
      tokenHash: hashToken(rawToken),
      pairingCode: null, // burn the one-time code
      pairingExp: null,
      pairedAt: new Date(),
      lastSeenAt: new Date(),
      ...(name ? { name } : {}),
    },
  })

  return { ok: true, token: rawToken, deviceId: device.id }
}

/** Authenticate an incoming extension request by bearer token. */
export async function authenticateDevice(
  bearer: string,
  options: { touchLastSeen?: boolean; allowRevocationPending?: boolean } = {},
): Promise<{ id: string; ownerUserId: string; revocationPending: boolean } | null> {
  const raw = (bearer ?? '').trim()
  if (!raw) return null
  const wanted = hashToken(raw)

  // Candidate set is tiny (the owner's devices); fetch active ones and constant-time
  // compare each hash so timing never reveals which device matched.
  const devices = await prisma.liveBrowserDevice.findMany({
    where: {
      tokenHash: { not: null },
      ...(!options.allowRevocationPending ? { revoked: false } : {}),
    },
    select: { id: true, ownerUserId: true, tokenHash: true, revoked: true },
  })
  for (const d of devices) {
    if (d.tokenHash && hashesEqual(d.tokenHash, wanted)) {
      if (!d.revoked && options.touchLastSeen !== false) {
        await prisma.liveBrowserDevice
          .update({ where: { id: d.id }, data: { lastSeenAt: new Date() } })
          .catch(() => {})
      }
      return { id: d.id, ownerUserId: d.ownerUserId, revocationPending: d.revoked }
    }
  }
  return null
}

/** Keep update-required legacy Companions out of active-device selection. */
export async function markLiveBrowserDeviceUpdateRequired(deviceId: string): Promise<void> {
  await prisma.liveBrowserDevice.updateMany({
    where: { id: deviceId, revoked: false },
    data: { lastSeenAt: null },
  })
}

async function liveBrowserDeviceAcceptsDispatch(
  client: Prisma.TransactionClient,
  deviceId: string,
): Promise<boolean> {
  const device = await client.liveBrowserDevice.findFirst({
    where: { id: deviceId, revoked: false, tokenHash: { not: null } },
    select: { id: true },
  })
  return Boolean(device)
}

/** Revoke (unpair) a device — clears its token so it can no longer poll. */
export async function revokeDevice(deviceId: string): Promise<void> {
  const result = await revokeDeviceSafely(deviceId)
  if (!result.revoked) {
    throw new Error(`device_revoke_waiting_for_${result.inFlightEffects}_executing_effects`)
  }
}

export interface SafeDeviceRevokeResult {
  revoked: boolean
  inFlightEffects: number
  stoppedQueuedOrDelivered: number
}

/**
 * Device-authenticated Unpair backstop. Never clear the bearer while an exact
 * authorized effect still needs result/frame authentication; the caller must
 * surface `stopping` and retry. With no executing effect, queued authority,
 * preview capture, and the bearer are revoked in one transaction.
 */
export async function revokeDeviceSafely(deviceId: string): Promise<SafeDeviceRevokeResult> {
  // Unpair pauses the Companion before this call, so no later poll can own stale
  // execution reconciliation. Reap bounded-outcome rows first under the normal
  // conversation -> global -> device lock order. The revoke transaction then
  // re-checks under global -> device; a newly authorized fresh effect still
  // wins and keeps its result/frame bearer until a later retry.
  await reconcileStaleBrowserExecutions(deviceId)
  return prisma.$transaction(async (tx) => {
    await lockLiveBrowserDispatchAuthority(tx)
    await lockLiveBrowserPreviewDevice(tx, deviceId)
    // `revoked=true, tokenHash!=null` is the durable revoke-pending state. It
    // removes this device from ordinary authentication/selection immediately,
    // while result/frame/unpair routes may explicitly authenticate the retained
    // token until the exact already-executing effect settles.
    await tx.liveBrowserDevice.updateMany({
      where: { id: deviceId, tokenHash: { not: null } },
      data: { revoked: true, lastSeenAt: null },
    })
    const stopped = await tx.liveBrowserCommand.updateMany({
      where: { deviceId, status: { in: ['queued', 'delivered'] } },
      data: {
        status: 'failed',
        error: 'device_unpaired_by_owner_before_execution',
        resolvedAt: new Date(),
      },
    })
    const inFlightEffects = await tx.liveBrowserCommand.count({
      where: { deviceId, status: 'executing' },
    })
    if (inFlightEffects > 0) {
      return {
        revoked: false,
        inFlightEffects,
        stoppedQueuedOrDelivered: stopped.count,
      }
    }

    const revoked = await tx.liveBrowserDevice.updateMany({
      where: { id: deviceId, revoked: true, tokenHash: { not: null } },
      data: { tokenHash: null },
    })
    if (revoked.count === 1) {
      await tx.liveBrowserPreviewLease.deleteMany({ where: { deviceId } })
    }
    return {
      revoked: revoked.count === 1,
      inFlightEffects: 0,
      stoppedQueuedOrDelivered: stopped.count,
    }
  })
}

// ---------------------------------------------------------------------------
// Device discovery (for the agent side)
// ---------------------------------------------------------------------------

export interface ActiveDevice {
  id: string
  name: string
  online: boolean
  lastSeenAt: Date | null
}

/** The owner's paired, non-revoked devices, newest pairing first. */
export async function listOwnerDevices(): Promise<ActiveDevice[]> {
  const ownerUserId = await resolveOwnerUserId()
  if (!ownerUserId) return []
  const rows = await prisma.liveBrowserDevice.findMany({
    where: { ownerUserId, revoked: false, tokenHash: { not: null } },
    orderBy: { pairedAt: 'desc' },
    select: { id: true, name: true, lastSeenAt: true },
  })
  const now = Date.now()
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    lastSeenAt: r.lastSeenAt,
    online: Boolean(r.lastSeenAt && now - r.lastSeenAt.getTime() < DEVICE_OFFLINE_MS),
  }))
}

/** Pick the device to drive: the most-recently-seen ONLINE one, else null. */
export async function pickActiveDevice(): Promise<ActiveDevice | null> {
  const devices = await listOwnerDevices()
  const online = devices.filter((d) => d.online)
  if (online.length === 0) return null
  online.sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))
  return online[0]
}

// ---------------------------------------------------------------------------
// Command bus
// ---------------------------------------------------------------------------

export interface RunResult {
  ok: boolean
  status: 'done' | 'failed' | 'timeout'
  data?: unknown
  screenshot?: string | null
  error?: string
  commandId: string
}

export interface BrowserActivityContext {
  turnId?: string | null
  conversationId?: string | null
  /** Server-owned fencing token for the exact witnessed-browser lane. */
  directBrowserLaneToken?: string | null
}

export interface CancelLiveBrowserTurnResult {
  found: boolean
  canceledCommands: number
  inFlightEffects?: number
}

export interface BrowserPreviewLease {
  deviceId: string
  turnId: string
  conversationId: string
  expiresAt: Date
}

/** Serialize command dispatch and preview renewal for one physical Companion.
 * Conversation locks cannot protect two different conversations sharing the
 * same Chrome device, so the preview row needs its own deterministic mutex. */
async function lockLiveBrowserPreviewDevice(
  tx: Prisma.TransactionClient,
  deviceId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`alma_live_browser_preview:${deviceId}`}, 0)
    )::text AS lock_token /* live_browser_preview_device */
  `)
}

interface BrowserTurnContext {
  turnId: string
  conversationId: string
}

interface StaleExecutionReconcileResult {
  count: number
  turnContexts: BrowserTurnContext[]
}

function staleExecutingWhere(scope: {
  deviceId?: string
  turnId?: string
  conversationId?: string
} = {}): Prisma.LiveBrowserCommandWhereInput {
  return {
    ...scope,
    status: 'executing',
    deliveredAt: { lt: new Date(Date.now() - BROWSER_DELIVERY_LEASE_MS) },
  }
}

async function terminalizeStaleBrowserExecutions(
  tx: Prisma.TransactionClient,
  scope: { deviceId?: string; turnId?: string; conversationId?: string } = {},
): Promise<StaleExecutionReconcileResult> {
  const stale = await tx.liveBrowserCommand.findMany({
    where: staleExecutingWhere(scope),
    select: {
      id: true,
      deviceId: true,
      deliveredAt: true,
      turnId: true,
      conversationId: true,
    },
  })
  const turnContexts = new Map<string, BrowserTurnContext>()
  let count = 0
  for (const row of stale) {
    if (!row.deliveredAt) continue
    const terminalized = await tx.liveBrowserCommand.updateMany({
      where: {
        id: row.id,
        deviceId: row.deviceId,
        status: 'executing',
        deliveredAt: row.deliveredAt,
      },
      data: {
        status: 'failed',
        error:
          'delivery_outcome_unknown: authorized command exceeded its bounded execution lease; ' +
          'automatic replay blocked — run a fresh live_browser_look',
        resolvedAt: new Date(),
      },
    })
    if (terminalized.count !== 1) continue
    count += 1
    if (row.turnId && row.conversationId) {
      turnContexts.set(`${row.conversationId}\u0000${row.turnId}`, {
        turnId: row.turnId,
        conversationId: row.conversationId,
      })
      await tx.liveBrowserPreviewLease.deleteMany({
        where: {
          deviceId: row.deviceId,
          turnId: row.turnId,
          conversationId: row.conversationId,
        },
      })
    }
  }
  return { count, turnContexts: [...turnContexts.values()] }
}

async function reconcileStaleBrowserExecutionsDetailed(
  deviceId?: string,
): Promise<StaleExecutionReconcileResult> {
  const observed = await prisma.liveBrowserCommand.findMany({
    where: staleExecutingWhere(deviceId ? { deviceId } : {}),
    select: { deviceId: true, turnId: true, conversationId: true },
  })
  if (observed.length === 0) return { count: 0, turnContexts: [] }

  const conversationIds = Array.from(new Set(observed.flatMap((row) => (
    row.conversationId ? [row.conversationId] : []
  )))).sort()
  const deviceIds = Array.from(new Set(observed.map((row) => row.deviceId))).sort()
  return prisma.$transaction(async (tx) => {
    // Same total order as enqueue/authorize/resolve. All candidate authority is
    // re-read after the locks; the initial rows are only a lock-discovery hint.
    for (const conversationId of conversationIds) {
      await lockDirectYouTubeLaneAuthority(tx, conversationId)
    }
    await lockLiveBrowserDispatchAuthority(tx)
    for (const candidateDeviceId of deviceIds) {
      await lockLiveBrowserPreviewDevice(tx, candidateDeviceId)
    }
    const reconciled = await terminalizeStaleBrowserExecutions(
      tx,
      deviceId ? { deviceId } : {},
    )
    for (const context of reconciled.turnContexts) {
      await settleCanceledBrowserTurnIfNoExecuting(
        tx,
        context.turnId,
        context.conversationId,
      )
    }
    return reconciled
  })
}

/** Server-owned bounded reconciliation; never depends on another device poll. */
export async function reconcileStaleBrowserExecutions(deviceId?: string): Promise<number> {
  return (await reconcileStaleBrowserExecutionsDetailed(deviceId)).count
}

const MAX_BROWSER_PREVIEW_CONTEXTS_PER_DEVICE = 8

async function trimBrowserPreviewContexts(deviceId: string): Promise<void> {
  const stale = await prisma.liveBrowserFrame.findMany({
    where: { deviceId },
    orderBy: { capturedAt: 'desc' },
    skip: MAX_BROWSER_PREVIEW_CONTEXTS_PER_DEVICE,
    select: { contextId: true },
  })
  if (stale.length > 0) {
    await prisma.liveBrowserFrame.deleteMany({
      where: { deviceId, contextId: { in: stale.map((row) => row.contextId) } },
    })
  }
}

function completeActivityContext(
  input?: BrowserActivityContext | null,
): { turnId: string; conversationId: string; directBrowserLaneToken?: string } | null {
  const turnId = input?.turnId?.trim()
  const conversationId = input?.conversationId?.trim()
  const directBrowserLaneToken = input?.directBrowserLaneToken?.trim()
  return turnId && conversationId
    ? {
        turnId,
        conversationId,
        ...(directBrowserLaneToken ? { directBrowserLaneToken } : {}),
      }
    : null
}

function durableCommandParams(
  params: Record<string, unknown> | undefined,
  directBrowserLaneToken?: string,
): Record<string, unknown> {
  return {
    ...(params ?? {}),
    ...(directBrowserLaneToken
      ? { [DIRECT_BROWSER_LANE_TOKEN_PARAM]: directBrowserLaneToken }
      : {}),
  }
}

function directBrowserLaneTokenFromParams(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ''
  const token = (params as Record<string, unknown>)[DIRECT_BROWSER_LANE_TOKEN_PARAM]
  return typeof token === 'string' ? token.trim() : ''
}

function companionVisibleCommandParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {}
  const visible = { ...(params as Record<string, unknown>) }
  delete visible[DIRECT_BROWSER_LANE_TOKEN_PARAM]
  return visible
}

/**
 * Owner Stop for a turn. Direct command enqueue takes the same deterministic
 * lane lock first, so Stop either revokes before enqueue or terminalizes every
 * queued command the earlier enqueue committed before this transaction returns.
 */
export async function cancelLiveBrowserTurn(turnId: string): Promise<CancelLiveBrowserTurnResult> {
  const target = await prisma.agentTurn.findUnique({
    where: { id: turnId },
    select: { id: true, conversationId: true },
  })
  if (!target) return { found: false, canceledCommands: 0 }

  return prisma.$transaction(async (tx) => {
    await lockDirectYouTubeLaneAuthority(tx, target.conversationId)
    // Final authorization uses conversation -> global -> device. Stop must use
    // the identical order so delivered and executing have one durable winner.
    await lockLiveBrowserDispatchAuthority(tx)
    const commandDevices = await tx.liveBrowserCommand.findMany({
      where: {
        turnId,
        conversationId: target.conversationId,
        status: { in: ['queued', 'delivered', 'executing'] },
      },
      distinct: ['deviceId'],
      select: { deviceId: true },
    })
    for (const deviceId of commandDevices.map((row) => row.deviceId).sort()) {
      await lockLiveBrowserPreviewDevice(tx, deviceId)
    }
    // Stop is a server-owned reconciliation point. A Companion with a lost
    // result/outbox must not be required to poll again before its bounded
    // executing lease can become terminal-unknown.
    await terminalizeStaleBrowserExecutions(tx, {
      turnId,
      conversationId: target.conversationId,
    })
    const inFlightEffects = await tx.liveBrowserCommand.count({
      where: { turnId, conversationId: target.conversationId, status: 'executing' },
    })
    const lanes = await tx.$queryRaw<Array<{
      id: string
      status: string
      currentStep: string | null
      version: number
      artifacts: unknown
    }>>(Prisma.sql`
      SELECT "id", "status", "current_step" AS "currentStep", "version", "artifacts"
      FROM "agent_conversation_focuses"
      WHERE "id" = ${directYouTubeLaneIdForConversation(target.conversationId)}
      FOR UPDATE
    `)
    const lane = lanes[0]
    const canceledAt = new Date()
    const laneArtifacts = lane?.artifacts && typeof lane.artifacts === 'object' && !Array.isArray(lane.artifacts)
      ? lane.artifacts as Record<string, unknown>
      : {}
    const expectedAskCardId = typeof laneArtifacts.expectedAskCardId === 'string'
      ? laneArtifacts.expectedAskCardId.trim()
      : ''
    const laneToken = typeof laneArtifacts.laneToken === 'string'
      ? laneArtifacts.laneToken.trim()
      : ''
    const laneBelongsToTurn = laneToken === turnId
    if (lane && laneBelongsToTurn && (lane.status === 'active' || lane.status === 'awaiting_owner')) {
      const revoked = await tx.agentConversationFocus.updateMany({
        where: { id: lane.id, version: lane.version },
        data: {
          status: 'abandoned',
          currentStep: 'canceled_by_owner',
          blocker: 'owner_canceled_turn',
          leaseUntil: canceledAt,
          completedAt: canceledAt,
          version: lane.version + 1,
        },
      })
      if (revoked.count !== 1) throw new Error('direct_browser_lane_cancel_conflict')
      await tx.agentFocusEvent.create({
        data: {
          focusId: lane.id,
          conversationId: target.conversationId,
          type: 'abandoned',
          fromStatus: lane.status,
          toStatus: 'abandoned',
          version: lane.version + 1,
          cause: 'owner_cancel',
          detail: { fromStep: lane.currentStep, targetTurnId: turnId },
        },
      })
    }

    // `ask_user` binds its card to the lane before returning success. Stop owns
    // the same lane lock, so it can revoke that UI authority in the very same
    // transaction—no late tap may fall through into an ordinary broad turn.
    if (laneBelongsToTurn && expectedAskCardId) {
      await tx.agentAskCard.updateMany({
        where: {
          id: expectedAskCardId,
          conversationId: target.conversationId,
          status: { in: ['pending', 'answered'] },
        },
        data: { status: 'superseded' },
      })
    }

    const activeTurn = await tx.agentTurn.findFirst({
      where: { id: turnId, conversationId: target.conversationId, status: 'running' },
      select: { id: true, cancelRequested: true },
    })
    const canceledTurn = activeTurn
      ? await tx.agentTurn.updateMany({
          where: {
            id: turnId,
            conversationId: target.conversationId,
            status: 'running',
            cancelRequested: activeTurn.cancelRequested,
          },
          data: inFlightEffects > 0
            ? { cancelRequested: true }
            : { cancelRequested: true, status: 'canceled', finishedAt: canceledAt },
        })
      : { count: 0 }
    const canceledCommands = await tx.liveBrowserCommand.updateMany({
      where: {
        turnId,
        conversationId: target.conversationId,
        status: { in: ['queued', 'delivered'] },
      },
      data: {
        status: 'failed',
        error: 'canceled_by_owner_before_delivery',
        resolvedAt: canceledAt,
      },
    })

    // Authorization already won. Cancel intent + lane revocation are durable,
    // so no next command can enqueue or claim. Keep only this turn's executing
    // preview alive until its result (or bounded unknown-outcome reclaim) settles.
    if (inFlightEffects > 0) {
      const witnessUntil = new Date(Date.now() + BROWSER_DELIVERY_LEASE_MS)
      await tx.liveBrowserPreviewLease.updateMany({
        where: {
          turnId,
          conversationId: target.conversationId,
          deviceId: { in: commandDevices.map((row) => row.deviceId) },
        },
        data: { expiresAt: witnessUntil },
      })
      return {
        found: canceledTurn.count === 1 || inFlightEffects > 0,
        canceledCommands: canceledCommands.count,
        inFlightEffects,
      }
    }
    await tx.liveBrowserPreviewLease.deleteMany({
      where: { turnId, conversationId: target.conversationId },
    })
    return { found: canceledTurn.count === 1, canceledCommands: canceledCommands.count }
  })
}

/**
 * Start/renew a short capture grant. The referenced turn must still own the
 * conversation, not merely remain `running`: an overlapping newer owner turn
 * revokes the older turn's right to keep watching immediately.
 */
export async function renewBrowserPreviewLease(input: {
  deviceId: string
  turnId: string
  conversationId: string
  ttlMs?: number
}): Promise<BrowserPreviewLease | null> {
  const context = completeActivityContext(input)
  if (!context) return null
  const ttlMs = Math.max(5_000, Math.min(input.ttlMs ?? BROWSER_PREVIEW_LEASE_TTL_MS, 60_000))
  return prisma.$transaction(async (tx) => {
    // Owner-message admission takes this same per-conversation lock. Therefore
    // the freshness decision and lease write have one order relative to a newer
    // owner turn instead of racing between a read and an unguarded upsert.
    await lockDirectYouTubeLaneAuthority(tx, context.conversationId)
    await lockLiveBrowserPreviewDevice(tx, input.deviceId)
    const inFlight = await tx.liveBrowserCommand.findFirst({
      where: { deviceId: input.deviceId, status: { in: ['delivered', 'executing'] } },
      select: { turnId: true, conversationId: true },
    })
    // A different current command owns the witnessed capture window until it
    // resolves. Another conversation may not overwrite that device-global
    // lease and make the in-flight effect invisible/misattributed.
    if (
      inFlight
      && (inFlight.turnId !== context.turnId || inFlight.conversationId !== context.conversationId)
    ) return null
    if (!await isTurnOwnerExecutionCurrent(context.conversationId, context.turnId, tx)) {
      await tx.liveBrowserPreviewLease.deleteMany({
        where: {
          deviceId: input.deviceId,
          turnId: context.turnId,
          conversationId: context.conversationId,
        },
      }).catch(() => {})
      return null
    }

    const expiresAt = new Date(Date.now() + ttlMs)
    return tx.liveBrowserPreviewLease.upsert({
      where: { deviceId: input.deviceId },
      create: {
        deviceId: input.deviceId,
        turnId: context.turnId,
        conversationId: context.conversationId,
        expiresAt,
      },
      update: {
        turnId: context.turnId,
        conversationId: context.conversationId,
        expiresAt,
      },
      select: { deviceId: true, turnId: true, conversationId: true, expiresAt: true },
    })
  })
}

/** Return a truthful grant for poll/frame ingest, clearing expired/terminal grants. */
export async function getActiveBrowserPreviewLease(
  deviceId: string,
  options: { requireExecuting?: boolean } = {},
): Promise<BrowserPreviewLease | null> {
  const observed = await prisma.liveBrowserPreviewLease.findUnique({
    where: { deviceId },
    select: { deviceId: true, turnId: true, conversationId: true, expiresAt: true },
  })
  if (!observed) return null
  if (observed.expiresAt.getTime() <= Date.now()) {
    await prisma.liveBrowserPreviewLease.deleteMany({
      where: {
        deviceId,
        turnId: observed.turnId,
        conversationId: observed.conversationId,
        expiresAt: observed.expiresAt,
      },
    }).catch(() => {})
    return null
  }

  return prisma.$transaction(async (tx) => {
    await lockDirectYouTubeLaneAuthority(tx, observed.conversationId)
    await lockLiveBrowserPreviewDevice(tx, deviceId)
    const lease = await tx.liveBrowserPreviewLease.findUnique({
      where: { deviceId },
      select: { deviceId: true, turnId: true, conversationId: true, expiresAt: true },
    })
    // The device may have received a different lease while we waited for the
    // observed conversation's lock. Never judge or delete that newer authority
    // under the old conversation lock; the caller can retry against it.
    if (
      !lease
      || lease.turnId !== observed.turnId
      || lease.conversationId !== observed.conversationId
      || lease.expiresAt.getTime() !== observed.expiresAt.getTime()
    ) return null

    const ownerCurrent = await isTurnOwnerExecutionCurrent(
      lease.conversationId,
      lease.turnId,
      tx,
    )
    const witnessedExecuting = !options.requireExecuting && ownerCurrent
      ? null
      : await tx.liveBrowserCommand.findFirst({
          where: {
            deviceId,
            turnId: lease.turnId,
            conversationId: lease.conversationId,
            status: 'executing',
          },
          select: { id: true },
        })
    // A Stop makes ordinary turn authority false immediately, but an effect
    // that already passed final authorization must remain visible until its
    // exact result settles. This exception grants capture only, never dispatch.
    const authorizedContext = options.requireExecuting
      ? Boolean(witnessedExecuting)
      : ownerCurrent || Boolean(witnessedExecuting)
    const current = lease.expiresAt.getTime() > Date.now() && authorizedContext
    if (!current) {
      await tx.liveBrowserPreviewLease.deleteMany({
        where: {
          deviceId,
          turnId: lease.turnId,
          conversationId: lease.conversationId,
          expiresAt: lease.expiresAt,
        },
      }).catch(() => {})
      return null
    }
    return lease
  })
}

export async function stopBrowserPreviewLeases(input: {
  deviceIds: string[]
  turnId: string
  conversationId: string
}): Promise<number> {
  if (input.deviceIds.length === 0) return 0
  const result = await prisma.liveBrowserPreviewLease.deleteMany({
    where: {
      deviceId: { in: input.deviceIds },
      turnId: input.turnId,
      conversationId: input.conversationId,
    },
  })
  return result.count
}

/**
 * Replace the per-device/context latest frame only when the producer clock
 * advances. The active lease supplies the trusted activity identity.
 */
export async function storeBrowserPreviewFrame(input: {
  deviceId: string
  contextId: string
  dataUri: string
  capturedAt: Date
  lease: BrowserPreviewLease
}): Promise<{ accepted: boolean; frameAt: Date; frameSeq: number }> {
  // Atomic per-context upsert: the server owns the sequence so an MV3 worker
  // restart cannot rewind it. Equal/older producer timestamps never replace pixels.
  const advanced = await prisma.$queryRaw<Array<{ capturedAt: Date; sequence: number }>>(
    Prisma.sql`
      INSERT INTO "live_browser_frames"
        ("deviceId", "contextId", "conversationId", "turnId", "dataUri",
         "capturedAt", "sequence", "createdAt", "updatedAt")
      VALUES
        (${input.deviceId}, ${input.contextId}, ${input.lease.conversationId},
         ${input.lease.turnId}, ${input.dataUri}, ${input.capturedAt}, 1, NOW(), NOW())
      ON CONFLICT ("deviceId", "contextId") DO UPDATE SET
        "conversationId" = EXCLUDED."conversationId",
        "turnId" = EXCLUDED."turnId",
        "dataUri" = EXCLUDED."dataUri",
        "capturedAt" = EXCLUDED."capturedAt",
        "sequence" = "live_browser_frames"."sequence" + 1,
        "updatedAt" = NOW()
      WHERE "live_browser_frames"."capturedAt" < EXCLUDED."capturedAt"
      RETURNING "capturedAt", "sequence"
    `,
  )
  if (advanced[0]) {
    await trimBrowserPreviewContexts(input.deviceId)
    return { accepted: true, frameAt: advanced[0].capturedAt, frameSeq: advanced[0].sequence }
  }
  const current = await prisma.liveBrowserFrame.findUniqueOrThrow({
    where: { deviceId_contextId: { deviceId: input.deviceId, contextId: input.contextId } },
    select: { capturedAt: true, sequence: true },
  })
  return { accepted: false, frameAt: current.capturedAt, frameSeq: current.sequence }
}

/**
 * Enqueue ONE command for a device and await its result (durable: the row survives
 * a server restart; this just polls the row). Returns timeout if the companion does
 * not resolve it in `timeoutMs` (e.g. Chrome closed, popup paused, tab busy).
 */
export async function runCommand(
  deviceId: string,
  action: LiveBrowserAction,
  params?: Record<string, unknown>,
  timeoutMs = COMMAND_DEFAULT_TIMEOUT_MS,
  activityContext?: BrowserActivityContext,
  /** Server-reserved one-effect id from the consumed LOOK receipt. */
  reservedCommandId?: string,
): Promise<RunResult> {
  if (!LIVE_BROWSER_ACTIONS.includes(action)) {
    return { ok: false, status: 'failed', error: `unsupported_action:${action}`, commandId: '' }
  }

  const context = completeActivityContext(activityContext)
  const commandId = reservedCommandId?.trim() ?? ''
  if (commandId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId)) {
    return { ok: false, status: 'failed', error: 'invalid_reserved_browser_command_id', commandId: '' }
  }
  const commandData = {
      ...(commandId ? { id: commandId } : {}),
      deviceId,
      action,
      params: durableCommandParams(params, context?.directBrowserLaneToken) as object,
      status: 'queued',
      turnId: context?.turnId ?? null,
      conversationId: context?.conversationId ?? null,
  }
  // Queue only. The preview lease is minted/renewed atomically when this exact
  // command is claimed, not here: a device-global enqueue lease could otherwise
  // be overwritten by a later conversation or expire while the command waits.
  let cmd: { id: string } | null
  let enqueueDeniedReason = ''
  try {
    cmd = await prisma.$transaction(async (tx) => {
        if (context) {
        await lockDirectYouTubeLaneAuthority(tx, context.conversationId)
        }
        // Linearize enqueue with global Stop/OFF. Stop-first leaves the flag
        // false for this read; enqueue-first commits a queued row that the
        // same Stop transaction subsequently sweeps before returning.
        await lockLiveBrowserDispatchAuthority(tx)
        if (!await liveBrowserEnabledFrom(tx)) {
          enqueueDeniedReason = 'live_browser_disabled_before_enqueue'
          return null
        }
        if (!await liveBrowserDeviceAcceptsDispatch(tx, deviceId)) {
          enqueueDeniedReason = 'device_unpair_pending_before_enqueue'
          return null
        }
        if (!context) {
          return tx.liveBrowserCommand.create({ data: commandData, select: { id: true } })
        }
        // Final durable execution fence. The row lock linearizes command
        // creation against owner steering: whichever transaction wins first is
        // authoritative. A stale/expired token can never enqueue a command.
        if (context.directBrowserLaneToken) {
          const lane = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id"
              FROM "agent_conversation_focuses"
              WHERE "id" = ${directYouTubeLaneIdForConversation(context.conversationId)}
                AND "kind" = 'direct_youtube_browser'
                AND "status" IN ('active', 'awaiting_owner')
                AND "current_step" IN ('open', 'continuing', 'awaiting_owner')
                AND "lease_until" > NOW()
                AND "artifacts"->>'laneToken' = ${context.directBrowserLaneToken}
              FOR UPDATE
            `,
          )
          if (!lane[0]) {
            enqueueDeniedReason = 'direct_browser_lane_stale'
            return null
          }
        }
        if (!await isTurnOwnerExecutionCurrent(context.conversationId, context.turnId, tx)) {
          enqueueDeniedReason = 'direct_browser_turn_superseded'
          return null
        }
        const turn = await tx.agentTurn.findFirst({
          where: {
            id: context.turnId,
            conversationId: context.conversationId,
            status: 'running',
            cancelRequested: false,
          },
          select: { id: true, startedAt: true },
        })
        // Cancel/stop is another authority boundary. A direct lane row may not
        // have settled yet, but a non-running AgentTurn must never enqueue.
        if (!turn) {
          enqueueDeniedReason = 'direct_browser_turn_not_running'
          return null
        }
        const dispatchBoundary = await liveBrowserDispatchNotBeforeFrom(tx)
        if (!turnStartedAfterDispatchBoundary(turn.startedAt, dispatchBoundary)) {
          enqueueDeniedReason = 'direct_browser_turn_predates_owner_stop'
          return null
        }
        return tx.liveBrowserCommand.create({ data: commandData, select: { id: true } })
        })
  } catch (error) {
    if (
      commandId
      && error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'P2002'
    ) {
      return {
        ok: false,
        status: 'failed',
        error: 'reserved_browser_command_already_exists: effect will not be dispatched twice',
        commandId,
      }
    }
    throw error
  }

  if (!cmd) {
    return {
      ok: false,
      status: 'failed',
      error: enqueueDeniedReason
        || 'direct_browser_lane_stale: owner steering, expiry, or a newer turn revoked command dispatch',
      commandId,
    }
  }

  const deadline = Date.now() + Math.max(2_000, Math.min(timeoutMs, 120_000))
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, COMMAND_POLL_INTERVAL_MS))
    const row = await prisma.liveBrowserCommand.findUnique({
      where: { id: cmd.id },
      select: { status: true, result: true, error: true },
    })
    if (!row) break
    if (row.status === 'done' || row.status === 'failed') {
      const result = (row.result ?? {}) as Record<string, unknown>
      const screenshot = typeof result.screenshot === 'string' ? result.screenshot : null
      return {
        ok: row.status === 'done',
        status: row.status,
        data: result.data ?? null,
        screenshot,
        error: row.error ?? undefined,
        commandId: cmd.id,
      }
    }
  }

  // Timed out — mark the row so a late companion result is ignored as stale.
  await prisma.liveBrowserCommand
    .updateMany({
      where: { id: cmd.id, status: { in: ['queued', 'delivered'] } },
      data: { status: 'failed', error: 'timeout (companion did not respond)', resolvedAt: new Date() },
    })
    .catch(() => {})
  return { ok: false, status: 'timeout', error: 'companion_offline_or_busy', commandId: cmd.id }
}

/**
 * Companion fetches its next queued command (claims it as delivered). Returns null
 * when idle. Oldest-first so commands run in order.
 */
export async function reclaimStaleBrowserDeliveries(deviceId: string): Promise<number> {
  const staleExecuting = await reconcileStaleBrowserExecutions(deviceId)
  const cutoff = new Date(Date.now() - BROWSER_DELIVERY_LEASE_MS)
  const stale = await prisma.liveBrowserCommand.findMany({
    where: { deviceId, status: 'delivered', deliveredAt: { lt: cutoff } },
    select: {
      id: true,
      action: true,
      deliveredAt: true,
      deliveryAttempts: true,
    },
  })
  for (const row of stale) {
    const observed = {
      id: row.id,
      deviceId,
      status: 'delivered',
      deliveredAt: row.deliveredAt,
    }
    if (!REPLAY_SAFE_DELIVERED_ACTIONS.has(row.action as LiveBrowserAction)) {
      await prisma.liveBrowserCommand.updateMany({
        where: observed,
        data: {
          status: 'failed',
          error:
            'delivery_outcome_unknown: command was authorized/delivered and may have executed; ' +
            'automatic replay blocked — run a fresh live_browser_look',
          resolvedAt: new Date(),
        },
      })
    } else if (row.deliveryAttempts >= MAX_BROWSER_DELIVERY_ATTEMPTS) {
      await prisma.liveBrowserCommand.updateMany({
        where: observed,
        data: {
          status: 'failed',
          error: 'delivery_lost: Chrome companion did not receive the command after bounded retries',
          resolvedAt: new Date(),
        },
      })
    } else {
      await prisma.liveBrowserCommand.updateMany({
        where: observed,
        data: { status: 'queued', deliveredAt: null },
      })
    }
  }
  return stale.length + staleExecuting
}

export async function claimNextCommand(
  deviceId: string,
  protocol?: string | null,
): Promise<{
  id: string
  action: string
  params: Record<string, unknown>
  preview: BrowserPreviewLease | null
} | null> {
  // This is deliberately enforced in the command bus as well as the HTTP
  // route. A legacy caller cannot accidentally claim a row and hand it to a
  // Companion that executes without the final authorize transition.
  if (!supportsLiveBrowserAuthorizeProtocol(protocol)) return null
  await reclaimStaleBrowserDeliveries(deviceId).catch(() => {})
  const next = await prisma.liveBrowserCommand.findFirst({
    where: { deviceId, status: 'queued' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      action: true,
      params: true,
      turnId: true,
      conversationId: true,
    },
  })
  if (!next) return null

  const directBrowserLaneToken = directBrowserLaneTokenFromParams(next.params)
  const claim = await prisma.$transaction(async (tx) => {
    const failQueuedDirectCommand = async (error: string) => {
      await tx.liveBrowserCommand.updateMany({
        where: { id: next.id, deviceId, status: 'queued' },
        data: { status: 'failed', error, resolvedAt: new Date() },
      })
      return null
    }

    if (next.turnId && next.conversationId) {
      await lockDirectYouTubeLaneAuthority(tx, next.conversationId)
    }
    await lockLiveBrowserDispatchAuthority(tx)
    if (!await liveBrowserEnabledFrom(tx)) {
      return failQueuedDirectCommand('live_browser_disabled_before_dispatch')
    }
    if (!await liveBrowserDeviceAcceptsDispatch(tx, deviceId)) {
      return failQueuedDirectCommand('device_unpair_pending_before_dispatch')
    }
    await lockLiveBrowserPreviewDevice(tx, deviceId)
    const inFlight = await tx.liveBrowserCommand.findFirst({
      where: { deviceId, status: { in: ['delivered', 'executing'] } },
      select: { id: true },
    })
    if (inFlight) return null

    if (directBrowserLaneToken) {
      if (!next.turnId || !next.conversationId) {
        return failQueuedDirectCommand('direct_browser_command_context_missing')
      }
      // Same first lock as enqueue and owner Stop. A queued command cannot move
      // to delivered after its lane token was revoked, replaced, or expired.
      const lane = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "agent_conversation_focuses"
        WHERE "id" = ${directYouTubeLaneIdForConversation(next.conversationId)}
          AND "kind" = 'direct_youtube_browser'
          AND "status" IN ('active', 'awaiting_owner')
          AND "current_step" IN ('open', 'continuing', 'awaiting_owner')
          AND "lease_until" > NOW()
          AND "artifacts"->>'laneToken' = ${directBrowserLaneToken}
        FOR UPDATE
      `)
      if (!lane[0]) return failQueuedDirectCommand('direct_browser_command_lane_stale')
    }

    // Contextual commands from older deployments may not carry the private lane
    // token marker. A terminal/canceled target turn is still sufficient to prove
    // they must not execute; direct commands additionally passed the lane check.
    if (next.turnId && next.conversationId) {
      if (!await isTurnOwnerExecutionCurrent(next.conversationId, next.turnId, tx)) {
        return failQueuedDirectCommand(
          directBrowserLaneToken
            ? 'direct_browser_command_turn_superseded'
            : 'browser_command_turn_superseded',
        )
      }
      const runningTurn = await tx.agentTurn.findFirst({
        where: {
          id: next.turnId,
          conversationId: next.conversationId,
          status: 'running',
          cancelRequested: false,
        },
        select: { id: true, startedAt: true },
      })
      if (!runningTurn) {
        return failQueuedDirectCommand(
          directBrowserLaneToken
            ? 'direct_browser_command_turn_not_running'
            : 'browser_command_turn_not_running',
        )
      }
      const dispatchBoundary = await liveBrowserDispatchNotBeforeFrom(tx)
      if (!turnStartedAfterDispatchBoundary(runningTurn.startedAt, dispatchBoundary)) {
        return failQueuedDirectCommand(
          directBrowserLaneToken
            ? 'direct_browser_command_turn_predates_owner_stop'
            : 'browser_command_turn_predates_owner_stop',
        )
      }
    }

    // Conditional claim: an overdue result or Stop may commit between findFirst
    // and this write. In either race, terminal state wins and nothing executes.
    const claimed = await tx.liveBrowserCommand.updateMany({
      where: { id: next.id, deviceId, status: 'queued' },
      data: {
        status: 'delivered',
        deliveredAt: new Date(),
        deliveryAttempts: { increment: 1 },
      },
    })
    if (claimed.count === 0) return null

    // Couple witnessed capture to the exact command at dispatch time. This
    // refreshes a lease that expired while queued and replaces any stale lease
    // with this command's own turn/conversation in the same transaction. If the
    // lease write fails, the claim rolls back and the effect is not dispatched.
    let preview: BrowserPreviewLease | null = null
    if (next.turnId && next.conversationId) {
      const expiresAt = new Date(Date.now() + BROWSER_PREVIEW_LEASE_TTL_MS)
      preview = await tx.liveBrowserPreviewLease.upsert({
        where: { deviceId },
        create: {
          deviceId,
          turnId: next.turnId,
          conversationId: next.conversationId,
          expiresAt,
        },
        update: {
          turnId: next.turnId,
          conversationId: next.conversationId,
          expiresAt,
        },
        select: { deviceId: true, turnId: true, conversationId: true, expiresAt: true },
      })
    }
    return {
      id: next.id,
      action: next.action,
      params: companionVisibleCommandParams(next.params),
      preview,
    }
  })
  return claim
}

/** Final pre-effect authorization used by the Companion after poll and before
 * page code runs. Stop and this transition share the global dispatch lock:
 * stop-first makes authorization fail; authorize-first becomes `executing`, so
 * Stop reports a pending in-flight effect instead of falsely acknowledging it. */
export async function authorizeClaimedBrowserCommand(
  deviceId: string,
  commandId: string,
): Promise<{ authorized: boolean; reason?: string }> {
  const observed = await prisma.liveBrowserCommand.findUnique({
    where: { id: commandId },
    select: { id: true, deviceId: true, turnId: true, conversationId: true },
  })
  if (!observed || observed.deviceId !== deviceId || !observed.turnId || !observed.conversationId) {
    return { authorized: false, reason: 'command_context_missing' }
  }

  return prisma.$transaction(async (tx) => {
    await lockDirectYouTubeLaneAuthority(tx, observed.conversationId!)
    await lockLiveBrowserDispatchAuthority(tx)
    await lockLiveBrowserPreviewDevice(tx, deviceId)

    const row = await tx.liveBrowserCommand.findUnique({
      where: { id: commandId },
      select: {
        id: true,
        deviceId: true,
        status: true,
        turnId: true,
        conversationId: true,
        params: true,
      },
    })
    const deny = async (reason: string) => {
      if (row?.deviceId === deviceId && row.status === 'delivered') {
        await tx.liveBrowserCommand.updateMany({
          where: { id: commandId, deviceId, status: 'delivered' },
          data: { status: 'failed', error: `dispatch_authorization_denied:${reason}`, resolvedAt: new Date() },
        })
      }
      return { authorized: false as const, reason }
    }
    if (
      !row
      || row.deviceId !== deviceId
      || row.status !== 'delivered'
      || row.turnId !== observed.turnId
      || row.conversationId !== observed.conversationId
    ) return deny('command_not_deliverable')
    if (!await liveBrowserEnabledFrom(tx)) return deny('live_browser_disabled')
    if (!await liveBrowserDeviceAcceptsDispatch(tx, deviceId)) {
      return deny('device_unpair_pending')
    }
    if (!await isTurnOwnerExecutionCurrent(row.conversationId!, row.turnId!, tx)) {
      return deny('owner_turn_superseded')
    }
    const runningTurn = await tx.agentTurn.findFirst({
      where: {
        id: row.turnId!,
        conversationId: row.conversationId!,
        status: 'running',
        cancelRequested: false,
      },
      select: { id: true, startedAt: true },
    })
    if (!runningTurn) return deny('turn_not_running')
    const dispatchBoundary = await liveBrowserDispatchNotBeforeFrom(tx)
    if (!turnStartedAfterDispatchBoundary(runningTurn.startedAt, dispatchBoundary)) {
      return deny('turn_predates_owner_stop')
    }

    const directToken = directBrowserLaneTokenFromParams(row.params)
    if (directToken) {
      const lane = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "agent_conversation_focuses"
        WHERE "id" = ${directYouTubeLaneIdForConversation(row.conversationId!)}
          AND "kind" = 'direct_youtube_browser'
          AND "status" IN ('active', 'awaiting_owner')
          AND "current_step" IN ('open', 'continuing', 'awaiting_owner')
          AND "lease_until" > NOW()
          AND "artifacts"->>'laneToken' = ${directToken}
        FOR UPDATE
      `)
      if (!lane[0]) return deny('direct_browser_lane_stale')
    }

    const lease = await tx.liveBrowserPreviewLease.findUnique({
      where: { deviceId },
      select: { turnId: true, conversationId: true, expiresAt: true },
    })
    if (
      !lease
      || lease.turnId !== row.turnId
      || lease.conversationId !== row.conversationId
      || lease.expiresAt.getTime() <= Date.now()
    ) return deny('preview_lease_inactive')

    const authorized = await tx.liveBrowserCommand.updateMany({
      where: { id: commandId, deviceId, status: 'delivered' },
      // Rebase the bounded unknown-outcome lease at final authorization. The
      // prior timestamp measures poll delivery and may already include the
      // authorization round-trip; execution receives the full 40s budget.
      data: { status: 'executing', deliveredAt: new Date() },
    })
    if (authorized.count === 1) {
      // The extension's bounded command ceiling is longer than the ordinary
      // preview TTL. Refresh capture through the execution lease so a late Stop
      // can still witness the already-authorized effect.
      await tx.liveBrowserPreviewLease.updateMany({
        where: {
          deviceId,
          turnId: row.turnId!,
          conversationId: row.conversationId!,
        },
        data: { expiresAt: new Date(Date.now() + BROWSER_DELIVERY_LEASE_MS) },
      })
    }
    return authorized.count === 1
      ? { authorized: true as const }
      : { authorized: false as const, reason: 'command_claim_changed' }
  })
}

async function settleCanceledBrowserTurnIfNoExecuting(
  tx: Prisma.TransactionClient,
  turnId: string,
  conversationId: string,
): Promise<boolean> {
  const remaining = await tx.liveBrowserCommand.count({
    where: { turnId, conversationId, status: 'executing' },
  })
  if (remaining > 0) return false

  const canceled = await tx.agentTurn.findFirst({
    where: { id: turnId, conversationId, cancelRequested: true },
    select: { id: true, status: true },
  })
  if (!canceled) return false

  const settledAt = new Date()
  if (canceled.status === 'running') {
    await tx.agentTurn.updateMany({
      where: { id: turnId, conversationId, status: 'running', cancelRequested: true },
      data: { status: 'canceled', finishedAt: settledAt },
    })
  }
  await tx.liveBrowserCommand.updateMany({
    where: { turnId, conversationId, status: { in: ['queued', 'delivered'] } },
    data: {
      status: 'failed',
      error: 'canceled_by_owner_before_delivery',
      resolvedAt: settledAt,
    },
  })
  await tx.liveBrowserPreviewLease.deleteMany({ where: { turnId, conversationId } })
  return true
}

/** Companion posts a command result back. Idempotent (ignores already-resolved rows). */
export async function resolveCommand(
  deviceId: string,
  commandId: string,
  payload: {
    ok: boolean
    data?: unknown
    screenshot?: string | null
    error?: string
    contextId?: string | null
  },
): Promise<{ ok: boolean; ignored?: boolean }> {
  const result: Record<string, unknown> = {}
  if (payload.data !== undefined) result.data = payload.data
  if (payload.screenshot) result.screenshot = payload.screenshot

  const observed = await prisma.liveBrowserCommand.findUnique({
    where: { id: commandId },
    select: { deviceId: true, turnId: true, conversationId: true },
  })
  if (!observed || observed.deviceId !== deviceId) return { ok: false }

  return prisma.$transaction(async (tx) => {
    if (observed.turnId && observed.conversationId) {
      await lockDirectYouTubeLaneAuthority(tx, observed.conversationId)
    }
    await lockLiveBrowserDispatchAuthority(tx)
    await lockLiveBrowserPreviewDevice(tx, deviceId)

    // A successful page effect is authoritative only after the explicit
    // delivered -> executing transition. A legacy Companion may report failure
    // from delivered (for example update_required/authorization denial), but it
    // can never upgrade delivered or queued directly to successful completion.
    const committed = await tx.liveBrowserCommand.updateMany({
      where: {
        id: commandId,
        deviceId,
        status: payload.ok ? 'executing' : { in: ['delivered', 'executing'] },
      },
      data: {
        status: payload.ok ? 'done' : 'failed',
        result: result as object,
        error: payload.ok ? null : payload.error ?? 'unknown_error',
        contextId: payload.contextId?.trim() || null,
        resolvedAt: new Date(),
      },
    })

    if (committed.count > 0) {
      if (observed.turnId && observed.conversationId) {
        await settleCanceledBrowserTurnIfNoExecuting(
          tx,
          observed.turnId,
          observed.conversationId,
        )
      }
      return { ok: true }
    }

    const row = await tx.liveBrowserCommand.findUnique({
      where: { id: commandId },
      select: { deviceId: true, status: true },
    })
    if (!row || row.deviceId !== deviceId) return { ok: false }
    return { ok: true, ignored: true }
  })
}

export function isWriteAction(action: LiveBrowserAction): boolean {
  return WRITE_ACTIONS.has(action)
}
