/**
 * Agent → owner IN-APP two-way call (plan C1, docs/AGENT_APP_CALL_PLAN.md).
 *
 * The ring is an APNs VoIP push (+ FCM on Android) into the owner's own app —
 * CallKit shows a WhatsApp-style full-screen incoming call anywhere in the
 * world, including the UAE where WhatsApp calls are blocked. On answer the app
 * opens a Gemini Live session carrying this call's `purpose` as the opening
 * brief (C2). No Agora, no PSTN, no new vendor.
 *
 * Ring lifecycle: 'ringing' → app posts 'answered'/'declined'/'failed', then
 * an answered call closes as 'completed' or 'failed'. The installation that
 * wins the answer compare-and-set owns that live call through its terminal
 * transition, so a late event from another ringing device cannot end it.
 * There is no server timer — `getAgentAppCallStatus()` lazily marks a ring
 * older than RING_WINDOW_MS as 'unanswered' and fires the cancel push, so the
 * PA-2 ladder cron and the salah scheduler can poll it without extra infra.
 *
 * Kill switch: AGENT_APP_CALL_ENABLED === 'false' disables ringing (default ON —
 * the owner asked for this path explicitly; flip the env to stop it).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { getCallPushTargets } from '@/agent/lib/call-push'
import { sendVoipCall, type VoipCallPayload } from '@/agent/lib/apns-voip'
import { sendFcmCall, fcmCallConfigured } from '@/agent/lib/fcm-call'
import { getOfficeCallDeliveryDevicesForUsers } from '@/agent/lib/office-call-devices'
import { normalizeCallInstallationId } from '@/agent/lib/call-installation-id'

/** CallKit rings ~60s; small buffer so a just-answered call is not swept. */
export const RING_WINDOW_MS = 75_000
export const AGENT_APP_CALL_STATUS_CONTRACT_VERSION = 2 as const
/** Missing-version clients are rejected automatically after this rollout window. */
const DEFAULT_AGENT_APP_CALL_LEGACY_V1_SUNSET_AT = '2026-09-15T00:00:00.000Z'
export const AGENT_APP_CALL_LEGACY_V1_SUNSET_AT =
  process.env.AGENT_APP_CALL_LEGACY_V1_SUNSET_AT?.trim()
  || DEFAULT_AGENT_APP_CALL_LEGACY_V1_SUNSET_AT
const LEGACY_V1_DEVICE_PREFIX = 'legacy-v1-owner:'

export function agentAppCallLegacyV1Allowed(
  now = new Date(),
  configuredSunsetAt = AGENT_APP_CALL_LEGACY_V1_SUNSET_AT,
): boolean {
  const sunsetAt = Date.parse(configuredSunsetAt)
  // An invalid operational override must fail closed instead of silently
  // extending the weaker owner-wide compatibility identity forever.
  return Number.isFinite(sunsetAt) && now.getTime() < sunsetAt
}

/** Stable, pseudonymous compatibility owner for pre-v2 native builds. */
export function legacyAgentAppCallDeviceId(authenticatedOwnerId: string): string {
  const digest = createHash('sha256')
    .update(`agent-app-call-legacy-v1:${authenticatedOwnerId}`)
    .digest('hex')
    .slice(0, 32)
  return `${LEGACY_V1_DEVICE_PREFIX}${digest}`
}

export type AgentAppCallSource = 'ladder' | 'salah' | 'manual'

export type RingOwnerAppResult =
  | { ok: true; callId: string; voipSent: number; fcmSent: number }
  | { ok: false; error: 'disabled' | 'no_owner' | 'no_devices' | 'push_failed' | 'db_error' | 'busy' }

export function agentAppCallEnabled(): boolean {
  return process.env.AGENT_APP_CALL_ENABLED !== 'false'
}

/** Active SUPER_ADMIN users — the owner's ERP identities (device-token keys). */
async function ownerUserIds(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', active: true },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/**
 * Byte-capped brief for the ring payload. VoIP pushes hard-fail over ~5KB and
 * a rejected push means NO RING AT ALL, so the cap must leave generous room
 * for the rest of the payload. Bangla is ~3 bytes/char — 2800 bytes carries a
 * full salah brief; longer manual briefs arrive complete via the post-answer
 * fetch, which stays authoritative.
 */
export function payloadPurposePreview(purpose: string, maxBytes = 2800): string {
  let out = ''
  let bytes = 0
  for (const ch of purpose) {
    // Count the bytes the character occupies INSIDE the serialized JSON body
    // (Codex P2: quotes/backslashes/newlines expand under JSON.stringify —
    // capping raw UTF-8 bytes could still push the wire payload past APNs'
    // limit and kill the ring).
    const b = Buffer.byteLength(JSON.stringify(ch).slice(1, -1), 'utf8')
    if (bytes + b > maxBytes) break
    out += ch
    bytes += b
  }
  return out
}

function ringPayload(
  callId: string,
  event: 'ring' | 'cancel',
  claimReceipt?: string,
  purpose?: string,
): VoipCallPayload {
  return {
    type: 'agent_call',
    schemaVersion: 1,
    broadcastId: callId,
    callId,
    callUUID: callId,
    channel: `agent_${callId}`,
    caller: 'ALMA',
    expiresAt: new Date(Date.now() + RING_WINDOW_MS).toISOString(),
    event,
    ...(event === 'ring' && claimReceipt ? { claimReceipt } : {}),
    ...(event === 'ring' && purpose ? { purpose: payloadPurposePreview(purpose) } : {}),
  }
}

function hashAgentAppCallClaimReceipt(receipt: string): string {
  return createHash('sha256').update(receipt).digest('hex')
}

function claimReceiptMatches(storedHash: string | null, value: unknown): boolean {
  if (!storedHash || !/^[a-f0-9]{64}$/.test(storedHash) || typeof value !== 'string') return false
  const receipt = value.trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(receipt)) return false
  const actual = Buffer.from(hashAgentAppCallClaimReceipt(receipt), 'hex')
  const expected = Buffer.from(storedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

type AgentCallPushTargets = {
  sandboxVoip: string[]
  productionVoip: string[]
  fcm: string[]
  eligibleInstallationIds: string[]
}

async function getAgentCallPushTargets(userIds: string[]): Promise<AgentCallPushTargets> {
  const [devices, legacy] = await Promise.all([
    getOfficeCallDeliveryDevicesForUsers(userIds),
    // Compatibility only: builds predating the encrypted installation registry
    // wrote PushKit tokens to PushSubscription.
    getCallPushTargets(userIds).catch(() => ({ voip: [], fcm: [] })),
  ])
  const sandboxVoip = new Set<string>()
  const productionVoip = new Set<string>()
  const fcm = new Set<string>()
  const currentVoip = new Set<string>()
  const eligibleInstallationIds = new Set<string>()

  for (const device of devices) {
    if (device.provider === 'apns_voip') {
      currentVoip.add(device.token)
      if (device.installationId) eligibleInstallationIds.add(device.installationId)
      ;(device.environment === 'production' ? productionVoip : sandboxVoip).add(device.token)
    } else if (device.provider === 'fcm') {
      fcm.add(device.token)
    }
  }
  // A legacy row has no APNs environment. Preserve the old deployment-level
  // contract, but never duplicate a token already classified by the new row.
  const legacyVoip = process.env.APNS_PRODUCTION === 'true' ? productionVoip : sandboxVoip
  for (const token of legacy.voip) {
    if (!currentVoip.has(token)) legacyVoip.add(token)
  }
  for (const token of legacy.fcm) fcm.add(token)

  return {
    sandboxVoip: [...sandboxVoip],
    productionVoip: [...productionVoip],
    fcm: [...fcm],
    eligibleInstallationIds: [...eligibleInstallationIds].sort(),
  }
}

async function sendAgentCallPush(targets: AgentCallPushTargets, payload: VoipCallPayload) {
  const [sandbox, production, fcm] = await Promise.all([
    targets.sandboxVoip.length
      ? sendVoipCall(targets.sandboxVoip, payload, { environment: 'sandbox' })
      : Promise.resolve([]),
    targets.productionVoip.length
      ? sendVoipCall(targets.productionVoip, payload, { environment: 'production' })
      : Promise.resolve([]),
    targets.fcm.length && fcmCallConfigured()
      ? sendFcmCall(targets.fcm, payload)
      : Promise.resolve([]),
  ])
  return {
    voipAttempted: targets.sandboxVoip.length + targets.productionVoip.length,
    voipSent: [...sandbox, ...production].filter((result) => result.ok).length,
    fcmAttempted: targets.fcm.length,
    fcmSent: fcm.filter((result) => result.ok).length,
  }
}

/**
 * Ring the owner's app. Creates the call row first (the app fetches the brief by
 * id on answer), then fires VoIP + FCM pushes. Best-effort on the push layer but
 * honest in the result: zero delivered pushes = ok:false so callers escalate.
 */
export async function ringOwnerApp(args: {
  purpose: string
  source: AgentAppCallSource
}): Promise<RingOwnerAppResult> {
  if (!agentAppCallEnabled()) return { ok: false, error: 'disabled' }
  // The sweep now awaits distributed ring cancellation. Keep it attached to
  // this request too: a serverless return must not abandon cleanup and then
  // misread the partial unique index as a live owner call.
  await sweepStaleAgentAppCalls().catch(() => 0)

  const owners = await ownerUserIds().catch(() => [])
  if (owners.length === 0) return { ok: false, error: 'no_owner' }

  const targets = await getAgentCallPushTargets(owners).catch(() => ({
    sandboxVoip: [], productionVoip: [], fcm: [], eligibleInstallationIds: [],
  }))
  if (targets.sandboxVoip.length === 0 && targets.productionVoip.length === 0 && targets.fcm.length === 0) {
    return { ok: false, error: 'no_devices' }
  }

  // One call at a time (review-bot P2s on PR #653): CallKit is configured for a
  // single call group, so a second ring while ANY call is live/ringing would be
  // rejected on-device while the server happily reported 'ringing'. That covers
  // both our own agent calls AND staff/office calls (OfficeCallSession). This
  // fast check is backed by a partial unique index on agent_app_calls (one
  // active row) so two concurrent ringers cannot both pass check-then-create.
  const busy = await prisma.agentAppCall.findFirst({
    where: {
      OR: [
        { status: 'ringing', createdAt: { gt: new Date(Date.now() - RING_WINDOW_MS) } },
        { status: 'answered', endedAt: null, answeredAt: { gt: new Date(Date.now() - 2 * 3600_000) } },
      ],
    },
    select: { id: true },
  }).catch(() => null)
  if (busy) return { ok: false, error: 'busy' }

  const officeBusy = await prisma.officeCallSession.findFirst({
    where: {
      state: { in: ['RINGING', 'ANSWERED', 'CONNECTING', 'CONNECTED', 'RECONNECTING'] },
      endedAt: null,
      maxEndsAt: { gt: new Date() },
    },
    select: { id: true },
  }).catch(() => null)
  if (officeBusy) return { ok: false, error: 'busy' }

  let callId: string
  const claimReceipt = randomBytes(32).toString('base64url')
  try {
    const row = await prisma.agentAppCall.create({
      data: {
        purpose: args.purpose.slice(0, 2000),
        source: args.source,
        eligibleDeviceIds: targets.eligibleInstallationIds,
        claimReceiptHash: hashAgentAppCallClaimReceipt(claimReceipt),
      },
      select: { id: true },
    })
    callId = row.id
  } catch (err) {
    // agent_app_calls_single_active (partial unique index): a concurrent ringer
    // won the claim between our check and this insert — that is 'busy', not a
    // database failure (review-bot P2: check-then-create must be atomic).
    const msg = (err as Error)?.message ?? ''
    const code = (err as { code?: string })?.code
    if (code === 'P2002' || msg.includes('agent_app_calls_single_active')) {
      return { ok: false, error: 'busy' }
    }
    console.warn('[agent-app-call] create failed:', msg)
    return { ok: false, error: 'db_error' }
  }

  const payload = ringPayload(callId, 'ring', claimReceipt, args.purpose)
  const delivery = await sendAgentCallPush(targets, payload)
  const { voipSent, fcmSent } = delivery

  // Only iOS VoIP counts as a RING today: the Android service ignores
  // 'agent_call' payloads until C5, so an FCM delivery must not make the
  // ladder wait through a ring stage nothing actually rang (review-bot P2).
  const rang = voipSent > 0

  await prisma.agentAppCall.update({
    where: { id: callId },
    data: {
      pushResult: {
        voip: { attempted: delivery.voipAttempted, delivered: voipSent },
        fcm: { attempted: delivery.fcmAttempted, delivered: fcmSent, countsAsRing: false },
      },
      ...(rang ? {} : { status: 'failed', endedAt: new Date() }),
    },
  }).catch(() => {})

  if (!rang) return { ok: false, error: 'push_failed' }
  console.log(`[agent-app-call] ring ${callId} (${args.source}) voip=${voipSent} fcm=${fcmSent}`)
  return { ok: true, callId, voipSent, fcmSent }
}

/**
 * Expire every stale ring (review-bot P1: salah rings are fire-and-forget —
 * nobody polls them, so without this they stay 'ringing' forever and the
 * cancel + missed-call pushes never fire). Runs from the 1-min call-escalations
 * cron and opportunistically before each new ring.
 */
export async function sweepStaleAgentAppCalls(): Promise<number> {
  const cutoff = new Date(Date.now() - RING_WINDOW_MS)
  const stale = await prisma.agentAppCall.findMany({
    where: { status: 'ringing', createdAt: { lt: cutoff } },
    select: { id: true },
    take: 20,
  })
  for (const row of stale) await getAgentAppCallStatus(row.id).catch(() => null)

  // An 'answered' row whose end never arrived (app killed mid-call, network
  // drop) would hold the single-active unique index FOREVER and block every
  // future ring. Missing terminal evidence is a failure, never a fabricated
  // successful completion. This is the explicit trusted-server recovery path
  // for calls whose device outbox never made it back.
  const zombie = await prisma.agentAppCall.updateMany({
    where: { status: 'answered', endedAt: null, answeredAt: { lt: new Date(Date.now() - 2 * 3600_000) } },
    data: { status: 'failed', endedAt: new Date() },
  }).catch(() => ({ count: 0 }))

  return stale.length + zombie.count
}

export type AgentAppCallStatus =
  | 'ringing' | 'answered' | 'completed' | 'declined' | 'unanswered' | 'failed'

/**
 * Current status with lazy ring expiry: a still-'ringing' row older than the
 * ring window becomes 'unanswered' and the devices get a cancel push so a
 * delayed delivery cannot ring a phone for a call the ladder already escalated.
 */
export async function getAgentAppCallStatus(id: string): Promise<AgentAppCallStatus | null> {
  const row = await prisma.agentAppCall.findUnique({
    where: { id },
    select: { status: true, createdAt: true },
  })
  if (!row) return null
  if (row.status !== 'ringing') return row.status as AgentAppCallStatus
  if (Date.now() - row.createdAt.getTime() <= RING_WINDOW_MS) return 'ringing'

  const swept = await prisma.agentAppCall.updateMany({
    where: { id, status: 'ringing' },
    data: { status: 'unanswered', endedAt: new Date() },
  })
  if (swept.count !== 1) {
    // Answer and expiry race on the same `ringing` predicate. If expiry loses,
    // return the durable winner rather than fabricating `unanswered` from our
    // stale pre-CAS read.
    const latest = await prisma.agentAppCall.findUnique({
      where: { id },
      select: { status: true },
    })
    return latest ? latest.status as AgentAppCallStatus : null
  }

  // Do not detach cancellation from the request/cron lifecycle: an accepted
  // expiry response waits until the now-dead ring's best-effort cancellation
  // attempt settles; it never abandons an in-flight push promise.
  await cancelOtherAgentCallRings(id)

  // Missed-call notification (owner request 2026-07-29) — WhatsApp parity.
  // Salah rings are excluded: the salah ladder already notifies on its own
  // cadence, and a missed push per escalation ring would spam every waqt.
  try {
    const expired = await prisma.agentAppCall.findUnique({
      where: { id },
      select: { source: true, purpose: true },
    })
    if (expired && expired.source !== 'salah') {
      const { pushNativeToOwner } = await import('@/agent/lib/native-owner-push')
      await pushNativeToOwner({
        tier: 1,
        title: '📞 মিসড কল — ALMA',
        message: `ALMA আপনাকে কল দিয়েছিল: ${expired.purpose.slice(0, 160)}`,
        category: 'urgent',
        actionUrl: '/agent',
        deliveryId: `agent-call-missed:${id}`,
      })
    }
  } catch { /* missed push is best-effort */ }
  return 'unanswered'
}

export type AgentAppCallDeviceStatus = 'answered' | 'declined' | 'completed' | 'failed'

export type AgentAppCallTransitionError =
  | 'not_found'
  | 'device_id_required'
  | 'device_mismatch'
  | 'device_not_eligible'
  | 'claim_receipt_required'
  | 'ownership_missing'
  | 'legacy_contract_sunset'
  | 'invalid_note'
  | 'invalid_transition'
  | 'terminal_conflict'
  | 'transition_raced'

export type AgentAppCallTransitionResult =
  | {
      ok: true
      changed: boolean
      idempotent: boolean
      superseded: boolean
      status: AgentAppCallStatus
    }
  | {
      ok: false
      changed: false
      error: AgentAppCallTransitionError
      retryable: boolean
      status: AgentAppCallStatus | null
    }

export type AgentAppCallTransitionInput = {
  status: AgentAppCallDeviceStatus
  /** Stable native installation id, not a per-request random UUID. */
  deviceId?: string
  /** Bearer proof from this exact ring's VoIP payload. */
  claimReceipt?: string
  /** Route-only compatibility marker for an omitted pre-v2 contract version. */
  legacyV1?: boolean
  summary?: string
  /** Server-only recovery. The public owner route never accepts this from JSON. */
  trustedServerReset?: boolean
}

export function normalizeAgentAppCallDeviceId(value: unknown): string | null {
  const id = normalizeCallInstallationId(value)
  // v2 callers cannot impersonate the compatibility identity namespace.
  return id && !id.startsWith(LEGACY_V1_DEVICE_PREFIX) ? id : null
}

function normalizeLegacyAgentAppCallDeviceId(value: unknown): string | null {
  const id = normalizeCallInstallationId(value)
  return id && /^legacy-v1-owner:[a-f0-9]{32}$/.test(id) ? id : null
}

function transitionFailure(
  error: AgentAppCallTransitionError,
  status: AgentAppCallStatus | null,
): AgentAppCallTransitionResult {
  return {
    ok: false,
    changed: false,
    error,
    retryable: error === 'transition_raced',
    status,
  }
}

function transitionSuccess(
  status: AgentAppCallStatus,
  changed: boolean,
  superseded = false,
): AgentAppCallTransitionResult {
  return { ok: true, changed, idempotent: !changed, superseded, status }
}

type TransitionRow = {
  status: string
  answeredAt: Date | null
  answeringDeviceId: string | null
  eligibleDeviceIds: string[]
  claimReceiptHash: string | null
}

function ownershipFailure(
  row: TransitionRow,
  deviceId: string | null,
  trustedServerReset: boolean,
  legacyV1: boolean,
): AgentAppCallTransitionError | null {
  if (trustedServerReset || row.answeredAt === null) return null
  // Rows answered before the ownership column existed are explicitly
  // migratable only by the temporary authenticated legacy-v1 identity or a
  // trusted server reset. A v2 device may never guess ownership retroactively.
  if (!row.answeringDeviceId) return legacyV1 ? null : 'ownership_missing'
  if (row.answeringDeviceId !== deviceId) return 'device_mismatch'
  return null
}

async function cancelOtherAgentCallRings(id: string): Promise<void> {
  try {
    const owners = await ownerUserIds()
    const cancel = ringPayload(id, 'cancel')
    const targets = await getAgentCallPushTargets(owners)
    await sendAgentCallPush(targets, cancel)
  } catch { /* cancel is best-effort, but always awaited */ }
}

/**
 * App-side status update with a monotonic database compare-and-set.
 *
 * Device contract:
 *  - every public transition carries the stable native installation `deviceId`;
 *  - ringing -> answered atomically stores that id as the call owner;
 *  - only that owner may post completed/failed (or retry answered) afterwards;
 *  - a trusted server recovery may close a legacy ownerless answered row.
 *
 * The rich result deliberately distinguishes an idempotent retry from a
 * conflict. A native outbox should retry only thrown/5xx failures or the rare
 * `transition_raced` result, and stop retrying every other 4xx/409 result.
 */
export async function markAgentAppCall(
  id: string,
  input: AgentAppCallTransitionInput,
): Promise<AgentAppCallTransitionResult> {
  const trustedServerReset = input.trustedServerReset === true
  const legacyV1 = input.legacyV1 === true
  const deviceId = legacyV1
    ? normalizeLegacyAgentAppCallDeviceId(input.deviceId)
    : normalizeAgentAppCallDeviceId(input.deviceId)
  if (legacyV1 && !agentAppCallLegacyV1Allowed()) {
    return transitionFailure('legacy_contract_sunset', null)
  }
  if (trustedServerReset && legacyV1) return transitionFailure('invalid_transition', null)
  if (trustedServerReset && input.status !== 'completed' && input.status !== 'failed') {
    return transitionFailure('invalid_transition', null)
  }
  if (!trustedServerReset && !deviceId) return transitionFailure('device_id_required', null)

  const summary = typeof input.summary === 'string' && input.summary.length > 0
    ? input.summary.slice(0, 4000)
    : undefined

  // A lost CAS means another installation/event advanced the row between our
  // read and write. Re-read to return its durable truth, never guess success.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await prisma.agentAppCall.findUnique({
      where: { id },
      select: {
        status: true,
        answeredAt: true,
        answeringDeviceId: true,
        eligibleDeviceIds: true,
        claimReceiptHash: true,
      },
    }) as TransitionRow | null
    if (!row) return transitionFailure('not_found', null)

    const current = row.status as AgentAppCallStatus
    const ownershipError = ownershipFailure(row, deviceId, trustedServerReset, legacyV1)
    if (ownershipError) return transitionFailure(ownershipError, current)

    if (current === 'ringing') {
      // Pre-v2 iOS posted `answered` and `completed` from separate Tasks. A
      // quick hang-up could therefore deliver the terminal event first. Keep
      // that old wire contract working only inside the bounded legacy window;
      // v2's ordered outbox must still prove answered before completed.
      const legacyCompletedBeforeAnswer = legacyV1 && input.status === 'completed'
      if (!legacyV1 && !trustedServerReset
          && (!deviceId || !row.eligibleDeviceIds.includes(deviceId))
          && !claimReceiptMatches(row.claimReceiptHash, input.claimReceipt)) {
        return transitionFailure('claim_receipt_required', current)
      }
      if (input.status === 'completed' && !legacyCompletedBeforeAnswer) {
        return transitionFailure('invalid_transition', current)
      }
      const now = new Date()
      const answered = input.status === 'answered'
      const claimsAnswerOwnership = answered || legacyCompletedBeforeAnswer
      const update = await prisma.agentAppCall.updateMany({
        where: {
          id,
          status: 'ringing',
          ...(claimsAnswerOwnership ? { answeringDeviceId: null } : {}),
        },
        data: claimsAnswerOwnership
          ? {
              status: legacyCompletedBeforeAnswer ? 'completed' : 'answered',
              answeredAt: now,
              answeringDeviceId: deviceId,
              ...(legacyCompletedBeforeAnswer ? { endedAt: now } : {}),
              ...(summary ? { summary } : {}),
            }
          : {
              status: input.status,
              endedAt: now,
              ...(summary ? { summary } : {}),
            },
      })
      if (update.count !== 1) continue

      // Any ringing exit closes the distributed ring. The answer winner ignores
      // its cancel because local CallKit is already answered; decline/failure
      // cancels delayed pushes so they cannot show a ghost call that the DB will
      // correctly refuse to resurrect.
      await cancelOtherAgentCallRings(id)
      return transitionSuccess(
        legacyCompletedBeforeAnswer ? 'completed' : input.status,
        true,
      )
    }

    if (current === 'answered') {
      if (input.status === 'answered') {
        if (legacyV1 && row.answeringDeviceId === null) {
          const claimed = await prisma.agentAppCall.updateMany({
            where: {
              id,
              status: 'answered',
              answeredAt: row.answeredAt,
              answeringDeviceId: null,
            },
            data: {
              answeringDeviceId: deviceId,
              ...(summary ? { summary } : {}),
            },
          })
          if (claimed.count !== 1) continue
          return transitionSuccess(current, true)
        }
        return transitionSuccess(current, false)
      }
      if (input.status !== 'completed' && input.status !== 'failed') {
        return transitionFailure('invalid_transition', current)
      }
      const update = await prisma.agentAppCall.updateMany({
        where: {
          id,
          status: 'answered',
          answeredAt: row.answeredAt,
          answeringDeviceId: row.answeringDeviceId,
        },
        data: {
          status: input.status,
          endedAt: new Date(),
          ...(legacyV1 && row.answeringDeviceId === null
            ? { answeringDeviceId: deviceId }
            : {}),
          ...(summary ? { summary } : {}),
        },
      })
      if (update.count !== 1) continue
      return transitionSuccess(input.status, true)
    }

    // Exact terminal retries are safe. An older answered event that arrives
    // after its own device's completed/failed event is also safely superseded.
    if (current === input.status) {
      if (legacyV1 && row.answeredAt !== null && row.answeringDeviceId === null) {
        const claimed = await prisma.agentAppCall.updateMany({
          where: {
            id,
            status: current,
            answeredAt: row.answeredAt,
            answeringDeviceId: null,
          },
          data: {
            answeringDeviceId: deviceId,
            ...(summary ? { summary } : {}),
          },
        })
        if (claimed.count !== 1) continue
        return transitionSuccess(current, true)
      }
      return transitionSuccess(current, false)
    }
    if (input.status === 'answered' && row.answeredAt !== null) {
      return transitionSuccess(current, false, true)
    }
    return transitionFailure('terminal_conflict', current)
  }

  const latest = await getAgentAppCallStatus(id)
  return transitionFailure('transition_raced', latest)
}

type DiagnosticRow = TransitionRow & {
  summary: string | null
  updatedAt: Date
}

function newestCompleteSummarySuffix(value: string, maxLength: number): string {
  if (maxLength <= 0 || value.length === 0) return ''
  if (value.length <= maxLength) return value
  let suffix = value.slice(-maxLength)
  // Never retain the back half of a UTF-16 surrogate pair.
  if (/^[\uDC00-\uDFFF]/.test(suffix)) suffix = suffix.slice(1)
  // A truncated first line is misleading. Drop it and retain only the newest
  // complete diagnostic/summary lines that fit beside the incoming note.
  const firstNewline = suffix.indexOf('\n')
  return firstNewline >= 0 ? suffix.slice(firstNewline + 1) : ''
}

/** Append a diagnostic only to the call owned by this exact installation. */
export async function appendAgentAppCallDeviceNote(
  id: string,
  input: { deviceId?: string; legacyV1?: boolean; note: string },
): Promise<AgentAppCallTransitionResult> {
  const legacyV1 = input.legacyV1 === true
  if (legacyV1 && !agentAppCallLegacyV1Allowed()) {
    return transitionFailure('legacy_contract_sunset', null)
  }
  const deviceId = legacyV1
    ? normalizeLegacyAgentAppCallDeviceId(input.deviceId)
    : normalizeAgentAppCallDeviceId(input.deviceId)
  if (!deviceId) return transitionFailure('device_id_required', null)
  const note = input.note.trim().slice(0, 500)
  if (!note) return transitionFailure('invalid_note', null)
  const line = `[device] ${note}`

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await prisma.agentAppCall.findUnique({
      where: { id },
      select: {
        status: true,
        answeredAt: true,
        answeringDeviceId: true,
        eligibleDeviceIds: true,
        claimReceiptHash: true,
        summary: true,
        updatedAt: true,
      },
    }) as DiagnosticRow | null
    if (!row) return transitionFailure('not_found', null)
    const current = row.status as AgentAppCallStatus

    // Diagnostics cannot claim an unowned ringing/legacy-migration row. The
    // note must accompany its lifecycle transition, or follow an accepted
    // answer whose installation ownership is already durable.
    if (row.answeredAt === null || row.answeringDeviceId === null) {
      return transitionFailure('ownership_missing', current)
    }
    const ownershipError = ownershipFailure(row, deviceId, false, legacyV1)
    if (ownershipError) return transitionFailure(ownershipError, current)

    if (row.summary === line || row.summary?.endsWith(`\n${line}`)) {
      return transitionSuccess(current, false)
    }
    const maxPriorLength = Math.max(0, 4000 - line.length - 1)
    const prior = newestCompleteSummarySuffix(row.summary ?? '', maxPriorLength)
    const summary = prior ? `${prior}\n${line}` : line
    const updated = await prisma.agentAppCall.updateMany({
      where: {
        id,
        status: row.status,
        answeredAt: row.answeredAt,
        answeringDeviceId: row.answeringDeviceId,
        updatedAt: row.updatedAt,
      },
      data: { summary },
    })
    if (updated.count !== 1) continue
    return transitionSuccess(current, true)
  }

  const latest = await getAgentAppCallStatus(id)
  return transitionFailure('transition_raced', latest)
}

/** The call's brief for the live session (C2 — /api/assistant/live-session?callId=). */
export async function getAgentAppCallBrief(id: string): Promise<{ purpose: string; source: string } | null> {
  const row = await prisma.agentAppCall.findUnique({
    where: { id },
    select: { purpose: true, source: true },
  })
  return row ?? null
}
