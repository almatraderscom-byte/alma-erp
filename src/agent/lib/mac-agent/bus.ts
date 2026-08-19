/**
 * M1 — the durable command bus between the agent and the owner's Mac.
 *
 * Shape (deliberately identical to the proven live-browser companion bus):
 *   • A tiny Node daemon runs on the Mac under launchd. It pairs once with a
 *     one-time code → gets a bearer token. From then on it LONG-POLLS this server
 *     and posts results back.
 *   • Nothing listens on the Mac. There is no inbound SSH, no open port, no
 *     tunnel — the Mac only ever makes outbound HTTPS calls it initiated. That is
 *     the single most important property of this design: compromising the server
 *     does not give anyone a socket into the owner's machine.
 *   • Queue lives in Postgres, never in memory (durability rule), so a Vercel
 *     cold start or a daemon restart can't lose or double-run a command.
 *
 * Safety layers, in the order an attacker would meet them:
 *   1. KV kill-switch `mac_agent_enabled`, default OFF — the capability does not
 *      exist until the owner turns it on.
 *   2. `classifyCommand` (policy.ts) refuses RED outright and forces AMBER through
 *      an owner approval card. Only green/amber rows are ever written here.
 *   3. The daemon re-runs the SAME classifier before executing, so a bug or a
 *      breach on this side still cannot make it run something dangerous.
 *   4. Every row keeps `policyLevel` + `approvedBy` forever — a complete audit
 *      trail of what ran on his Mac and what authorised it.
 */
import { createHash, timingSafeEqual, randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { classifyCommand, MAC_EXEC_LIMITS, type PolicyLevel } from '@/agent/lib/mac-agent/policy'
import { classifyUiAction } from '@/agent/lib/mac-agent/ui-policy'

const MAC_EXEC_LIMITS_MAX_TIMEOUT = MAC_EXEC_LIMITS.maxTimeoutMs

/** KV kill-switch (owner-tunable, no redeploy). Default OFF — capability is opt-in. */
export const MAC_AGENT_ENABLED_KEY = 'mac_agent_enabled'

/** Verbs the daemon knows. M1 ships run_command/ping; the session_* verbs are M2;
 * the ui_* verbs are L8 (driving the allowlisted desktop apps through the AX tree). */
export const MAC_AGENT_ACTIONS = [
  'ping',
  'run_command',
  'screenshot',
  'session_open',
  'session_send',
  'session_read',
  'session_stop',
  'session_list',
  'power',
  'screen_stream',
  'ui_tree',
  'ui_screenshot',
  'ui_scroll',
  'ui_click',
  'ui_type',
  'ui_key',
  // P0-3 (foundation audit G): session identity as a first-class read, and
  // "open a new chat" as one act with a verified postcondition.
  'ui_session',
  'ui_new_chat',
  // P1-10: the daemon has mirrored an app's live chat into the dock since W3,
  // but no server verb ever reached it — the audit's "tool exists and is
  // invisible" class, hit for the third time in this repo.
  'app_mirror',
] as const
export type MacAgentAction = (typeof MAC_AGENT_ACTIONS)[number]

const AUTO_STREAM_ACTIONS = new Set<MacAgentAction>([
  'run_command',
  'screenshot',
  'ui_tree',
  'ui_screenshot',
  'ui_scroll',
  'ui_click',
  'ui_type',
  'ui_key',
  'ui_session',
  'ui_new_chat',
  'app_mirror',
])
const AUTO_STREAM_FRESH_MS = 10_000
const AUTO_STREAM_MAX_SECONDS = 120

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000
const DEVICE_OFFLINE_MS = 90_000
/** How long the agent waits for a result before giving up on a synchronous run. */
export const RESULT_WAIT_DEFAULT_MS = 150_000
const RESULT_POLL_INTERVAL_MS = 800

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

export async function isMacAgentEnabled(): Promise<boolean> {
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: MAC_AGENT_ENABLED_KEY },
      select: { value: true },
    })
    return row?.value === 'true'
  } catch {
    return false
  }
}

/**
 * Separate switch for UI driving (L8), default OFF: the shipped daemon answers
 * every ui_* verb with `unknown_action` until W3's driver is deployed on the
 * Mac, so exposing the verbs before then would fail every read and burn
 * approved cards on nothing (Codex P1 on the W4 PR). The owner flips this in
 * KV once the updated daemon is running — same plane as mac_agent_enabled.
 */
export const MAC_UI_ENABLED_KEY = 'mac_ui_driving_enabled'

/**
 * Tri-state read: `true`/`false` are the owner's actual switch, `null` means
 * the KV row could not be READ (a DB blip). Callers must treat the two
 * negatives differently — OFF is a decision, unreadable is not, and only a
 * decision may destroy queued work.
 */
export async function readMacUiDrivingSwitch(): Promise<boolean | null> {
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: MAC_UI_ENABLED_KEY },
      select: { value: true },
    })
    return row?.value === 'true'
  } catch {
    return null
  }
}

/** Fail-closed boolean for intake paths (tool + approve): unreadable = refuse. */
export async function isMacUiDrivingEnabled(): Promise<boolean> {
  return (await readMacUiDrivingSwitch()) === true
}

export async function setMacAgentEnabled(enabled: boolean): Promise<boolean> {
  const value = enabled ? 'true' : 'false'
  await prisma.agentKvSetting.upsert({
    where: { key: MAC_AGENT_ENABLED_KEY },
    create: { key: MAC_AGENT_ENABLED_KEY, value },
    update: { value },
  })
  return enabled
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

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

async function resolveOwnerUserId(): Promise<string | null> {
  try {
    const { resolveOwnerUserIds } = await import('@/agent/lib/native-owner-push')
    const ids = await resolveOwnerUserIds()
    return ids[0] ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface PairingTicket {
  deviceId: string
  code: string
  expiresAt: Date
  deviceName: string
}

export async function createPairingTicket(deviceName?: string): Promise<PairingTicket> {
  const ownerUserId = await resolveOwnerUserId()
  if (!ownerUserId) throw new Error('owner_user_unresolved')

  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS)
  const name = (deviceName ?? '').trim() || 'My Mac'

  const device = await prisma.macAgentDevice.create({
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

/** Daemon redeems a one-time code → bearer token. Raw token returned ONCE. */
export async function redeemPairingCode(
  code: string,
  opts: { deviceName?: string; meta?: Record<string, unknown> } = {},
): Promise<RedeemResult> {
  const trimmed = (code ?? '').trim().toUpperCase()
  if (!trimmed) return { ok: false, error: 'code_required' }

  const device = await prisma.macAgentDevice.findUnique({
    where: { pairingCode: trimmed },
    select: { id: true, pairingExp: true, revoked: true },
  })
  if (!device) return { ok: false, error: 'invalid_code' }
  if (device.revoked) return { ok: false, error: 'device_revoked' }
  if (!device.pairingExp || device.pairingExp.getTime() < Date.now()) {
    return { ok: false, error: 'code_expired' }
  }

  const rawToken = randomBytes(32).toString('hex')
  const name = (opts.deviceName ?? '').trim()

  await prisma.macAgentDevice.update({
    where: { id: device.id },
    data: {
      tokenHash: hashToken(rawToken),
      pairingCode: null, // burn the one-time code
      pairingExp: null,
      pairedAt: new Date(),
      lastSeenAt: new Date(),
      ...(name ? { name } : {}),
      ...(opts.meta ? { meta: opts.meta as object } : {}),
    },
  })

  return { ok: true, token: rawToken, deviceId: device.id }
}

export async function authenticateDevice(
  bearer: string,
): Promise<{ id: string; ownerUserId: string } | null> {
  const raw = (bearer ?? '').trim()
  if (!raw) return null
  const wanted = hashToken(raw)

  // The candidate set is the owner's own handful of devices; compare every hash in
  // constant time so response timing never reveals which one matched.
  const devices = await prisma.macAgentDevice.findMany({
    where: { revoked: false, tokenHash: { not: null } },
    select: { id: true, ownerUserId: true, tokenHash: true },
  })
  for (const d of devices) {
    if (d.tokenHash && hashesEqual(d.tokenHash, wanted)) {
      await prisma.macAgentDevice
        .update({ where: { id: d.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {})
      return { id: d.id, ownerUserId: d.ownerUserId }
    }
  }
  return null
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await prisma.macAgentDevice.update({
    where: { id: deviceId },
    data: { revoked: true, tokenHash: null },
  })
}

// ---------------------------------------------------------------------------
// Device discovery
// ---------------------------------------------------------------------------

export interface MacDevice {
  id: string
  name: string
  online: boolean
  lastSeenAt: Date | null
  pairedAt: Date | null
  meta: Record<string, unknown> | null
}

function toMacDevice(d: {
  id: string
  name: string
  lastSeenAt: Date | null
  pairedAt: Date | null
  meta: unknown
}): MacDevice {
  return {
    id: d.id,
    name: d.name,
    online: Boolean(d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < DEVICE_OFFLINE_MS),
    lastSeenAt: d.lastSeenAt,
    pairedAt: d.pairedAt,
    meta: (d.meta as Record<string, unknown> | null) ?? null,
  }
}

export async function listDevices(): Promise<MacDevice[]> {
  const rows = await prisma.macAgentDevice.findMany({
    where: { revoked: false },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, name: true, lastSeenAt: true, pairedAt: true, meta: true },
  })
  return rows.map(toMacDevice)
}

/**
 * The Mac to send work to: the most recently-seen ONLINE paired device. Returns
 * null when nothing is online, so callers can tell the owner his Mac is asleep
 * instead of queueing a command nobody will ever collect.
 */
export async function activeDevice(): Promise<MacDevice | null> {
  const devices = await listDevices()
  return devices.find((d) => d.online && d.pairedAt) ?? null
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  deviceId: string
  action: MacAgentAction
  params?: Record<string, unknown>
  policyLevel?: PolicyLevel
  approvedBy?: string | null
  sessionKey?: string | null
  turnId?: string | null
  conversationId?: string | null
}

/**
 * Idle-seconds sentinel for SERVER-side UI classification. The server cannot
 * know how recently the owner touched his keyboard — only the daemon can — so
 * the server judges the PERMANENT questions (which app, which element, what
 * text) with idle treated as satisfied, and the daemon re-judges with the REAL
 * measurement before synthesising anything. `owner_active` is a runtime defer,
 * not an approval question, so this weakens nothing.
 */
export const UI_SERVER_IDLE_SENTINEL = Number.MAX_SAFE_INTEGER

export async function enqueueCommand(input: EnqueueInput): Promise<{ id: string }> {
  // Belt and braces: a RED command must never reach the queue, no matter which
  // caller made the mistake. The tool layer checks first; this is the backstop.
  if (input.action === 'run_command') {
    const cmd = String(input.params?.command ?? '')
    const verdict = classifyCommand(cmd, { cwd: input.params?.cwd as string | undefined })
    if (verdict.level === 'red') throw new Error(`red_command_rejected:${verdict.code}`)
    if (verdict.level === 'amber' && !input.approvedBy) {
      throw new Error('amber_command_requires_approval')
    }
  }
  // Same backstop for UI driving (L8): no RED action reaches the queue, and no
  // amber one without a card behind it. The daemon still re-judges with the
  // real owner-idle measurement.
  if (input.action.startsWith('ui_')) {
    const p = input.params ?? {}
    const verdict = classifyUiAction({
      action: input.action,
      bundleId: p.bundleId as string | undefined,
      elementLabel: p.elementLabel as string | undefined,
      text: p.text as string | undefined,
      key: p.key as string | undefined,
      focusedLabel: p.focusedLabel as string | undefined,
      ownerIdleSeconds: UI_SERVER_IDLE_SENTINEL,
    })
    if (verdict.level === 'red') throw new Error(`red_ui_action_rejected:${verdict.code}`)
    if (verdict.level === 'amber' && !input.approvedBy) {
      throw new Error('amber_ui_action_requires_approval')
    }
  }

  const commandData = {
      deviceId: input.deviceId,
      action: input.action,
      params: (input.params ?? {}) as object,
      policyLevel: input.policyLevel ?? 'green',
      approvedBy: input.approvedBy ?? null,
      sessionKey: input.sessionKey ?? null,
      turnId: input.turnId?.trim() || null,
      conversationId: input.conversationId?.trim() || null,
  }
  const hasActivityContext = Boolean(commandData.turnId && commandData.conversationId)
  const shouldAutoStream = hasActivityContext && AUTO_STREAM_ACTIONS.has(input.action)
  const row = shouldAutoStream
      ? await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`mac-stream:${input.deviceId}`}))`)
        const runningTurn = await tx.agentTurn.findFirst({
          where: {
            id: commandData.turnId!,
            conversationId: commandData.conversationId!,
            status: 'running',
          },
          select: { id: true },
        })
        // An approval or retry can arrive after its original turn has ended.
        // Keep the requested command/audit row, but never begin background
        // capture when no live dock can still own and stop that stream.
        if (!runningTurn) {
          return tx.macAgentCommand.create({ data: commandData, select: { id: true } })
        }
        const [frame, existing] = await Promise.all([
          tx.macAgentFrame.findUnique({
            where: { deviceId: input.deviceId },
            select: { at: true, turnId: true, conversationId: true },
          }),
          tx.macAgentCommand.findFirst({
            where: {
              deviceId: input.deviceId,
              turnId: commandData.turnId,
              conversationId: commandData.conversationId,
              action: 'screen_stream',
              status: { in: ['queued', 'delivered', 'done'] },
              createdAt: { gt: new Date(Date.now() - AUTO_STREAM_MAX_SECONDS * 1000) },
            },
            orderBy: { createdAt: 'desc' },
            select: { params: true, status: true },
          }),
        ])
        const existingParams = (existing?.params as Record<string, unknown> | null) ?? null
        const streamFresh = Boolean(
          frame
          && frame.turnId === commandData.turnId
          && frame.conversationId === commandData.conversationId
          && Date.now() - frame.at.getTime() < AUTO_STREAM_FRESH_MS,
        )
        const autoAlreadyQueued = existingParams?.mode === 'start'
          && existingParams?.reason === 'computer_use'
          && (existing?.status === 'queued'
            || existing?.status === 'delivered'
            || (existing?.status === 'done' && streamFresh))
        let prependedAt: Date | null = null
        if (!streamFresh && !autoAlreadyQueued) {
          prependedAt = new Date()
          await tx.macAgentCommand.create({
            data: {
              deviceId: input.deviceId,
              action: 'screen_stream',
              params: {
                mode: 'start',
                reason: 'computer_use',
                maxSeconds: AUTO_STREAM_MAX_SECONDS,
              },
              policyLevel: 'green',
              turnId: commandData.turnId,
              conversationId: commandData.conversationId,
              createdAt: prependedAt,
            },
          })
        }
        return tx.macAgentCommand.create({
          data: prependedAt
            ? { ...commandData, createdAt: new Date(prependedAt.getTime() + 1) }
            : commandData,
          select: { id: true },
        })
      })
    : input.action === 'screen_stream'
      ? await prisma.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`mac-stream:${input.deviceId}`}))`)
          return tx.macAgentCommand.create({ data: commandData, select: { id: true } })
        })
      : await prisma.macAgentCommand.create({ data: commandData, select: { id: true } })
  return { id: row.id }
}

export interface ClaimedCommand {
  id: string
  action: string
  params: Record<string, unknown>
  sessionKey: string | null
  turnId: string | null
  conversationId: string | null
}

/**
 * Longest a row may sit in `delivered` before we assume the daemon never got it.
 * Sized above the maximum command timeout so a legitimately slow command is
 * never yanked out from under a daemon that IS running it.
 */
const DELIVERY_LEASE_MS = MAC_EXEC_LIMITS_MAX_TIMEOUT + 120_000
/**
 * Stream control is idempotent and completes immediately on the daemon. A
 * short lease prevents a lost poll response from leaving the prepended start
 * phantom-delivered while the visual command behind it runs with no pixels.
 */
export const SCREEN_STREAM_DELIVERY_LEASE_MS = 8_000
/** Give up (and tell the owner) rather than redeliver forever. */
const MAX_DELIVERY_ATTEMPTS = 3

/**
 * Rescue commands whose delivery was lost.
 *
 * `claimNextCommand` marks a row `delivered` before the HTTP response reaches
 * the Mac. If that response is lost — a deploy, a dropped connection — the row
 * sits in `delivered` forever and the owner's command silently never happens
 * (found in review). Anything past its lease goes back to `queued`; after a few
 * attempts it fails loudly instead, because a command that keeps disappearing is
 * information the owner needs, not something to retry in silence.
 */
export async function reclaimStaleDeliveries(deviceId: string): Promise<number> {
  const ordinaryCutoff = new Date(Date.now() - DELIVERY_LEASE_MS)
  const streamCutoff = new Date(Date.now() - SCREEN_STREAM_DELIVERY_LEASE_MS)
  const stale = await prisma.macAgentCommand.findMany({
    where: {
      deviceId,
      status: 'delivered',
      OR: [
        { action: 'screen_stream', deliveredAt: { lt: streamCutoff } },
        { action: { not: 'screen_stream' }, deliveredAt: { lt: ordinaryCutoff } },
      ],
    },
    select: { id: true, deliveredAt: true, deliveryAttempts: true },
  })
  if (stale.length === 0) return 0

  for (const row of stale) {
    if (row.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
      await prisma.macAgentCommand.updateMany({
        where: { id: row.id, deviceId, status: 'delivered', deliveredAt: row.deliveredAt },
        data: {
          status: 'failed',
          error: 'delivery_lost: Mac থেকে কোনো উত্তর আসেনি (কয়েকবার চেষ্টার পরেও)।',
          resolvedAt: new Date(),
        },
      })
      continue
    }
    await prisma.macAgentCommand.updateMany({
      where: { id: row.id, deviceId, status: 'delivered', deliveredAt: row.deliveredAt },
      data: { status: 'queued', deliveredAt: null, deliveryAttempts: { increment: 1 } },
    })
  }
  return stale.length
}

/**
 * Hand the daemon its next command. Uses a conditional update so two overlapping
 * polls (a retry, a restarted daemon) can never both claim the same row.
 */
export async function claimNextCommand(deviceId: string): Promise<ClaimedCommand | null> {
  // Cheap and only touches rows that are already past their deadline.
  await reclaimStaleDeliveries(deviceId).catch(() => {})

  const next = await prisma.macAgentCommand.findFirst({
    // One serial daemon must observe queue order across a lost poll response.
    // If the oldest unresolved row is still delivered, return no later work;
    // once its action-specific lease expires the reclaim above requeues it.
    where: { deviceId, status: { in: ['queued', 'delivered'] } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      action: true,
      status: true,
      params: true,
      sessionKey: true,
      turnId: true,
      conversationId: true,
    },
  })
  if (!next) return null
  if (next.status === 'delivered') return null

  // The UI kill switch must stop QUEUED work too, not just intake: a ui_*
  // command enqueued while driving was ON must not execute after the owner
  // turns it OFF (Codex round 3, ruled P1 by the head). Cancelled loudly, not
  // held — a held command executing minutes later against a changed app state
  // is the exact failure the approval card protects against.
  if (next.action.startsWith('ui_')) {
    const uiSwitch = await readMacUiDrivingSwitch()
    // Unreadable is NOT off: a DB blip must not destroy a command the owner
    // already approved. Deliver nothing this poll; the row stays queued.
    if (uiSwitch === null) return null
    if (uiSwitch === false) {
      // `cancelled`, not `failed`: the audit trail must read as "the owner
      // stopped this", not "the system broke" — matching cancelAllQueued.
      await prisma.macAgentCommand.updateMany({
        where: { id: next.id, status: 'queued' },
        data: {
          status: 'cancelled',
          error: 'ui_driving_disabled: Mac-এর অ্যাপ চালানো বন্ধ করা হয়েছে — কাজটা বাতিল হলো।',
          resolvedAt: new Date(),
        },
      })
      return claimNextCommand(deviceId)
    }
  }

  const claimed = await prisma.macAgentCommand.updateMany({
    where: { id: next.id, status: 'queued' },
    data: { status: 'delivered', deliveredAt: new Date() },
  })
  if (claimed.count === 0) return null // someone else took it

  return {
    id: next.id,
    action: next.action,
    params: (next.params as Record<string, unknown>) ?? {},
    sessionKey: next.sessionKey,
    turnId: next.turnId,
    conversationId: next.conversationId,
  }
}

export interface ResolveInput {
  ok: boolean
  exitCode?: number | null
  stdout?: string | null
  stderr?: string | null
  error?: string | null
}

export async function resolveCommand(
  deviceId: string,
  commandId: string,
  result: ResolveInput,
): Promise<{ ok: boolean; ignored?: boolean }> {
  const row = await prisma.macAgentCommand.findFirst({
    where: { id: commandId, deviceId },
    select: { id: true, status: true },
  })
  if (!row) return { ok: false }
  // A late duplicate post (daemon retried after a network blip) must not overwrite
  // the finished row — record it as ignored instead.
  if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
    return { ok: true, ignored: true }
  }

  await prisma.macAgentCommand.update({
    where: { id: commandId },
    data: {
      status: result.ok ? 'done' : 'failed',
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
      error: result.error ?? null,
      resolvedAt: new Date(),
    },
  })
  return { ok: true }
}

export interface CommandOutcome {
  id: string
  status: string
  exitCode: number | null
  stdout: string
  stderr: string
  error: string | null
  timedOut: boolean
}

/** The verb a command carries — the result route needs it to size its output cap. */
export async function getCommandAction(commandId: string): Promise<string | null> {
  const row = await prisma.macAgentCommand.findUnique({
    where: { id: commandId },
    select: { action: true },
  })
  return row?.action ?? null
}

/** Result-side metadata for durable proof reconciliation. */
export async function getCommandContext(commandId: string): Promise<{
  action: string
  params: Record<string, unknown>
} | null> {
  const row = await prisma.macAgentCommand.findUnique({
    where: { id: commandId },
    select: { action: true, params: true },
  })
  if (!row) return null
  return { action: row.action, params: (row.params as Record<string, unknown>) ?? {} }
}

/**
 * Transfer an AFTER screenshot from the synchronous approval waiter to the
 * durable result-route reconciler. The status predicate makes the handoff
 * atomic with respect to a result that already became terminal: count=0 means
 * the approval route still owns and can collect that completed row itself.
 */
export async function markUiProofDeferred(commandId: string): Promise<boolean> {
  const row = await prisma.macAgentCommand.findUnique({
    where: { id: commandId },
    select: { status: true, params: true },
  })
  if (!row || (row.status !== 'queued' && row.status !== 'delivered')) return false
  const params = (row.params as Record<string, unknown>) ?? {}
  const marked = await prisma.macAgentCommand.updateMany({
    where: { id: commandId, status: { in: ['queued', 'delivered'] } },
    data: { params: { ...params, proofDeferred: true } },
  })
  return marked.count === 1
}

export async function getCommand(commandId: string): Promise<CommandOutcome | null> {
  const row = await prisma.macAgentCommand.findUnique({
    where: { id: commandId },
    select: { id: true, status: true, exitCode: true, stdout: true, stderr: true, error: true },
  })
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    exitCode: row.exitCode,
    stdout: row.stdout ?? '',
    stderr: row.stderr ?? '',
    error: row.error,
    timedOut: false,
  }
}

/**
 * Wait for a queued command to finish. Polling (not a socket) because Vercel
 * functions are short-lived and the DB is the only thing both sides share.
 */
export async function awaitResult(
  commandId: string,
  waitMs = RESULT_WAIT_DEFAULT_MS,
): Promise<CommandOutcome> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const row = await getCommand(commandId)
    if (!row) {
      return { id: commandId, status: 'missing', exitCode: null, stdout: '', stderr: '', error: 'command_not_found', timedOut: false }
    }
    if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') return row
    if (Date.now() >= deadline) return { ...row, timedOut: true }
    await new Promise((r) => setTimeout(r, RESULT_POLL_INTERVAL_MS))
  }
}

/** Cancel everything still queued — the owner's STOP button. */
export async function cancelAllQueued(deviceId?: string): Promise<number> {
  const res = await prisma.macAgentCommand.updateMany({
    where: { status: { in: ['queued', 'delivered'] }, ...(deviceId ? { deviceId } : {}) },
    data: { status: 'cancelled', error: 'cancelled_by_owner', resolvedAt: new Date() },
  })
  return res.count
}

/** Recent history for the owner-facing status page (newest first). */
export async function recentCommands(limit = 20): Promise<
  Array<{
    id: string
    action: string
    command: string | null
    policyLevel: string
    status: string
    exitCode: number | null
    createdAt: Date
  }>
> {
  const rows = await prisma.macAgentCommand.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(1, limit), 100),
    select: {
      id: true,
      action: true,
      params: true,
      policyLevel: true,
      status: true,
      exitCode: true,
      createdAt: true,
    },
  })
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    command: ((r.params as Record<string, unknown> | null)?.command as string) ?? null,
    policyLevel: r.policyLevel,
    status: r.status,
    exitCode: r.exitCode,
    createdAt: r.createdAt,
  }))
}
