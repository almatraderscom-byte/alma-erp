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
  'navigate',
  'go_back',
  'switch_tab',
  'close_tab',
])

const COMMAND_DEFAULT_TIMEOUT_MS = 45_000
const COMMAND_POLL_INTERVAL_MS = 700
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000 // a one-time code is valid for 10 minutes
const DEVICE_OFFLINE_MS = 90_000 // no poll in 90s ⇒ treat the companion as offline

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
): Promise<RunResult> {
  if (!LIVE_BROWSER_ACTIONS.includes(action)) {
    return { ok: false, status: 'failed', error: `unsupported_action:${action}`, commandId: '' }
  }

  const cmd = await prisma.liveBrowserCommand.create({
    data: { deviceId, action, params: (params ?? {}) as object, status: 'queued' },
    select: { id: true },
  })

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
    .update({
      where: { id: cmd.id },
      data: { status: 'failed', error: 'timeout (companion did not respond)', resolvedAt: new Date() },
    })
    .catch(() => {})
  return { ok: false, status: 'timeout', error: 'companion_offline_or_busy', commandId: cmd.id }
}

/**
 * Companion fetches its next queued command (claims it as delivered). Returns null
 * when idle. Oldest-first so commands run in order.
 */
export async function claimNextCommand(deviceId: string): Promise<{
  id: string
  action: string
  params: Record<string, unknown>
} | null> {
  const next = await prisma.liveBrowserCommand.findFirst({
    where: { deviceId, status: 'queued' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, action: true, params: true },
  })
  if (!next) return null

  // Mark delivered (best-effort; single companion per device so no contention).
  await prisma.liveBrowserCommand
    .update({ where: { id: next.id }, data: { status: 'delivered', deliveredAt: new Date() } })
    .catch(() => {})

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
  payload: { ok: boolean; data?: unknown; screenshot?: string | null; error?: string },
): Promise<{ ok: boolean; ignored?: boolean }> {
  const row = await prisma.liveBrowserCommand.findUnique({
    where: { id: commandId },
    select: { deviceId: true, status: true },
  })
  if (!row || row.deviceId !== deviceId) return { ok: false }
  if (row.status === 'done' || row.status === 'failed') return { ok: true, ignored: true }

  const result: Record<string, unknown> = {}
  if (payload.data !== undefined) result.data = payload.data
  if (payload.screenshot) result.screenshot = payload.screenshot

  await prisma.liveBrowserCommand.update({
    where: { id: commandId },
    data: {
      status: payload.ok ? 'done' : 'failed',
      result: result as object,
      error: payload.ok ? null : payload.error ?? 'unknown_error',
      resolvedAt: new Date(),
    },
  })
  return { ok: true }
}

export function isWriteAction(action: LiveBrowserAction): boolean {
  return WRITE_ACTIONS.has(action)
}
