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

/** KV kill-switch (owner-tunable, no redeploy). Default OFF — capability is opt-in. */
export const LIVE_BROWSER_ENABLED_KEY = 'live_browser_enabled'

/** Command verbs the extension knows how to run. Mirrors background.js ALLOWED_ACTIONS. */
export const LIVE_BROWSER_ACTIONS = [
  'ping',
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

const COMMAND_DEFAULT_TIMEOUT_MS = 90_000
const COMMAND_POLL_INTERVAL_MS = 700
/** Longer than the extension's 35s whole-command ceiling, so live work is never reclaimed. */
export const BROWSER_DELIVERY_LEASE_MS = 40_000
const MAX_BROWSER_DELIVERY_ATTEMPTS = 3
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000 // a one-time code is valid for 10 minutes
const DEVICE_OFFLINE_MS = 90_000 // no poll in 90s ⇒ treat the companion as offline
export const BROWSER_PREVIEW_LEASE_TTL_MS = 25_000

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

/** Reads the live-browser kill-switch (KV). Default OFF. */
export async function isLiveBrowserEnabled(): Promise<boolean> {
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: LIVE_BROWSER_ENABLED_KEY },
      select: { value: true },
    })
    return row?.value === 'true'
  } catch {
    return false
  }
}

/** Flip the kill-switch. Returns the new state. */
export async function setLiveBrowserEnabled(enabled: boolean): Promise<boolean> {
  const value = enabled ? 'true' : 'false'
  await prisma.agentKvSetting.upsert({
    where: { key: LIVE_BROWSER_ENABLED_KEY },
    create: { key: LIVE_BROWSER_ENABLED_KEY, value },
    update: { value },
  })
  return enabled
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
): Promise<{ id: string; ownerUserId: string } | null> {
  const raw = (bearer ?? '').trim()
  if (!raw) return null
  const wanted = hashToken(raw)

  // Candidate set is tiny (the owner's devices); fetch active ones and constant-time
  // compare each hash so timing never reveals which device matched.
  const devices = await prisma.liveBrowserDevice.findMany({
    where: { revoked: false, tokenHash: { not: null } },
    select: { id: true, ownerUserId: true, tokenHash: true },
  })
  for (const d of devices) {
    if (d.tokenHash && hashesEqual(d.tokenHash, wanted)) {
      await prisma.liveBrowserDevice
        .update({ where: { id: d.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {})
      return { id: d.id, ownerUserId: d.ownerUserId }
    }
  }
  return null
}

/** Revoke (unpair) a device — clears its token so it can no longer poll. */
export async function revokeDevice(deviceId: string): Promise<void> {
  await prisma.liveBrowserDevice.update({
    where: { id: deviceId },
    data: { revoked: true, tokenHash: null },
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
}

export interface BrowserPreviewLease {
  deviceId: string
  turnId: string
  conversationId: string
  expiresAt: Date
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
): { turnId: string; conversationId: string } | null {
  const turnId = input?.turnId?.trim()
  const conversationId = input?.conversationId?.trim()
  return turnId && conversationId ? { turnId, conversationId } : null
}

/**
 * Start/renew a short capture grant. The referenced turn must still be running;
 * callers cannot turn an old command into an unbounded screen recorder.
 */
export async function renewBrowserPreviewLease(input: {
  deviceId: string
  turnId: string
  conversationId: string
  ttlMs?: number
}): Promise<BrowserPreviewLease | null> {
  const context = completeActivityContext(input)
  if (!context) return null
  const turn = await prisma.agentTurn.findFirst({
    where: { id: context.turnId, conversationId: context.conversationId, status: 'running' },
    select: { id: true },
  })
  if (!turn) return null

  const ttlMs = Math.max(5_000, Math.min(input.ttlMs ?? BROWSER_PREVIEW_LEASE_TTL_MS, 60_000))
  const expiresAt = new Date(Date.now() + ttlMs)
  const lease = await prisma.liveBrowserPreviewLease.upsert({
    where: { deviceId: input.deviceId },
    create: { deviceId: input.deviceId, ...context, expiresAt },
    update: { ...context, expiresAt },
    select: { deviceId: true, turnId: true, conversationId: true, expiresAt: true },
  })
  return lease
}

/** Return a truthful grant for poll/frame ingest, clearing expired/terminal grants. */
export async function getActiveBrowserPreviewLease(
  deviceId: string,
): Promise<BrowserPreviewLease | null> {
  const lease = await prisma.liveBrowserPreviewLease.findUnique({
    where: { deviceId },
    select: { deviceId: true, turnId: true, conversationId: true, expiresAt: true },
  })
  if (!lease) return null
  if (lease.expiresAt.getTime() <= Date.now()) {
    await prisma.liveBrowserPreviewLease.deleteMany({
      where: {
        deviceId,
        turnId: lease.turnId,
        conversationId: lease.conversationId,
        expiresAt: lease.expiresAt,
      },
    }).catch(() => {})
    return null
  }
  const turn = await prisma.agentTurn.findFirst({
    where: { id: lease.turnId, conversationId: lease.conversationId, status: 'running' },
    select: { id: true },
  })
  if (!turn) {
    await prisma.liveBrowserPreviewLease.deleteMany({
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
): Promise<RunResult> {
  if (!LIVE_BROWSER_ACTIONS.includes(action)) {
    return { ok: false, status: 'failed', error: `unsupported_action:${action}`, commandId: '' }
  }

  const context = completeActivityContext(activityContext)
  const commandData = {
      deviceId,
      action,
      params: (params ?? {}) as object,
      status: 'queued',
      turnId: context?.turnId ?? null,
      conversationId: context?.conversationId ?? null,
  }
  // When this is a real agent turn, publish the preview lease and the queued
  // command in ONE commit. Poll can never claim the command first and make the
  // extension spend the whole action without a capture grant.
  const cmd = context
    ? await prisma.$transaction(async (tx) => {
        const turn = await tx.agentTurn.findFirst({
          where: { id: context.turnId, conversationId: context.conversationId, status: 'running' },
          select: { id: true },
        })
        if (turn) {
          const expiresAt = new Date(Date.now() + BROWSER_PREVIEW_LEASE_TTL_MS)
          await tx.liveBrowserPreviewLease.upsert({
            where: { deviceId },
            create: { deviceId, ...context, expiresAt },
            update: { ...context, expiresAt },
          })
        }
        return tx.liveBrowserCommand.create({ data: commandData, select: { id: true } })
      })
    : await prisma.liveBrowserCommand.create({ data: commandData, select: { id: true } })

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
  const cutoff = new Date(Date.now() - BROWSER_DELIVERY_LEASE_MS)
  const stale = await prisma.liveBrowserCommand.findMany({
    where: { deviceId, status: 'delivered', deliveredAt: { lt: cutoff } },
    select: { id: true, deliveredAt: true, deliveryAttempts: true },
  })
  for (const row of stale) {
    const observed = {
      id: row.id,
      deviceId,
      status: 'delivered',
      deliveredAt: row.deliveredAt,
    }
    if (row.deliveryAttempts >= MAX_BROWSER_DELIVERY_ATTEMPTS) {
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
  return stale.length
}

export async function claimNextCommand(deviceId: string): Promise<{
  id: string
  action: string
  params: Record<string, unknown>
} | null> {
  await reclaimStaleBrowserDeliveries(deviceId).catch(() => {})
  const next = await prisma.liveBrowserCommand.findFirst({
    where: { deviceId, status: 'queued' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, action: true, params: true },
  })
  if (!next) return null

  // Conditional claim: an overdue result may commit between findFirst and this
  // write. In that race, `done` wins and the command is never executed twice.
  const claimed = await prisma.liveBrowserCommand.updateMany({
    where: { id: next.id, deviceId, status: 'queued' },
    data: {
      status: 'delivered',
      deliveredAt: new Date(),
      deliveryAttempts: { increment: 1 },
    },
  })
  if (claimed.count === 0) return null

  return {
    id: next.id,
    action: next.action,
    params: (next.params ?? {}) as Record<string, unknown>,
  }
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

  const committed = await prisma.liveBrowserCommand.updateMany({
    where: {
      id: commandId,
      deviceId,
      status: { in: ['queued', 'delivered'] },
    },
    data: {
      status: payload.ok ? 'done' : 'failed',
      result: result as object,
      error: payload.ok ? null : payload.error ?? 'unknown_error',
      contextId: payload.contextId?.trim() || null,
      resolvedAt: new Date(),
    },
  })
  if (committed.count > 0) return { ok: true }

  const row = await prisma.liveBrowserCommand.findUnique({
    where: { id: commandId },
    select: { deviceId: true, status: true },
  })
  if (!row || row.deviceId !== deviceId) return { ok: false }
  return { ok: true, ignored: true }
}

export function isWriteAction(action: LiveBrowserAction): boolean {
  return WRITE_ACTIONS.has(action)
}
