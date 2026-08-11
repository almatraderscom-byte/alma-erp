/**
 * App-side status leg of an agent → owner in-app call (plan C1/C2).
 * The iOS/Android app posts here from the CallKit answer/decline/hangup path
 * using the owner's own session cookie (same auth as the rest of the app).
 *
 * POST v2 { contractVersion: 2, status, deviceId, summary?, note? }
 * Missing contractVersion temporarily maps to an authenticated-owner legacy
 * identity until AGENT_APP_CALL_LEGACY_V1_SUNSET_AT; all unknown versions fail.
 * GET  → { status, purpose }   (the app fetches the brief while connecting)
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  AGENT_APP_CALL_LEGACY_V1_SUNSET_AT,
  AGENT_APP_CALL_STATUS_CONTRACT_VERSION,
  agentAppCallLegacyV1Allowed,
  appendAgentAppCallDeviceNote,
  getAgentAppCallStatus,
  getAgentAppCallBrief,
  legacyAgentAppCallDeviceId,
  markAgentAppCall,
  normalizeAgentAppCallDeviceId,
  type AgentAppCallDeviceStatus,
} from '@/agent/lib/agent-app-call'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { error: disabled }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { ok: true as const, ownerUserId: token.sub }
}

type DeviceContract = {
  deviceId: string
  legacyV1: boolean
  responseVersion: 1 | 2
}

function transitionSummary(rawSummary: unknown, note?: string): string | undefined {
  const summary = typeof rawSummary === 'string' && rawSummary.length > 0
    ? rawSummary
    : undefined
  if (!note) return summary
  const line = `[device] ${note}`
  if (!summary) return line
  // Preserve the diagnostic at the end of the same atomic lifecycle write.
  // markAgentAppCall caps at 4,000 UTF-16 code units, so reserve the line's
  // exact space here instead of letting an explicit summary truncate it away.
  const maxPriorLength = Math.max(0, 4000 - line.length - 1)
  let prior = summary.slice(0, maxPriorLength)
  if (/[\uD800-\uDBFF]$/.test(prior)) prior = prior.slice(0, -1)
  return prior ? `${prior}\n${line}` : line
}

function lifecycleError(error: string, httpStatus: number) {
  return Response.json(
    {
      ok: false,
      changed: false,
      error,
      retryable: false,
      status: null,
      supportedContractVersion: AGENT_APP_CALL_STATUS_CONTRACT_VERSION,
      ...(error === 'legacy_contract_sunset'
        ? { legacySunsetAt: AGENT_APP_CALL_LEGACY_V1_SUNSET_AT }
        : {}),
    },
    { status: httpStatus },
  )
}

function resolveDeviceContract(
  contractVersion: unknown,
  rawDeviceId: unknown,
  authenticatedOwnerId: string,
): DeviceContract | Response {
  if (contractVersion === undefined) {
    if (!agentAppCallLegacyV1Allowed()) {
      return lifecycleError('legacy_contract_sunset', 426)
    }
    return {
      deviceId: legacyAgentAppCallDeviceId(authenticatedOwnerId),
      legacyV1: true,
      responseVersion: 1,
    }
  }
  if (contractVersion !== AGENT_APP_CALL_STATUS_CONTRACT_VERSION) {
    return lifecycleError('unsupported_contract_version', 400)
  }
  const deviceId = normalizeAgentAppCallDeviceId(rawDeviceId)
  if (!deviceId) return lifecycleError('device_id_required', 400)
  return { deviceId, legacyV1: false, responseVersion: 2 }
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error

  const [status, brief] = await Promise.all([
    getAgentAppCallStatus(params.id),
    getAgentAppCallBrief(params.id),
  ])
  if (!status || !brief) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ status, purpose: brief.purpose, source: brief.source })
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error

  let body: {
    contractVersion?: unknown
    status?: unknown
    summary?: unknown
    note?: unknown
    deviceId?: unknown
    claimReceipt?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return lifecycleError('invalid_json', 400)
  }
  const status = body.status
  const hasNote = typeof body.note === 'string' && body.note.trim().length > 0
  const noteOnly = hasNote && (body.status === undefined || body.status === null)
  if (!noteOnly && status !== 'answered' && status !== 'declined'
      && status !== 'completed' && status !== 'failed') {
    return lifecycleError('invalid_status', 400)
  }
  const contract = resolveDeviceContract(
    body.contractVersion,
    body.deviceId,
    auth.ownerUserId,
  )
  if (contract instanceof Response) return contract

  // `note` carries an on-device diagnostic (e.g. why live audio never started).
  // It is logged only after the ownership-gated database write succeeds.
  const note = hasNote ? (body.note as string).trim().slice(0, 500) : undefined
  const summary = transitionSummary(body.summary, note)
  if (noteOnly && note) {
    const result = await appendAgentAppCallDeviceNote(params.id, {
      deviceId: contract.deviceId,
      legacyV1: contract.legacyV1,
      note,
    })
    if (contract.legacyV1) {
      console.warn('[agent-call] legacy-v1 status contract', {
        callId: params.id,
        legacyDeviceId: contract.deviceId,
        accepted: result.ok,
        sunsetAt: AGENT_APP_CALL_LEGACY_V1_SUNSET_AT,
      })
    }
    if (result.ok && result.changed) {
      console.warn('[agent-call] accepted device note', params.id, note)
    }
    if (!result.ok) {
      const httpStatus = result.error === 'not_found' ? 404
        : result.error === 'legacy_contract_sunset' ? 426
          : 409
      return Response.json({ ...result, contractVersion: contract.responseVersion }, { status: httpStatus })
    }
    return Response.json({ ...result, contractVersion: contract.responseVersion, noteSaved: true })
  }

  const result = await markAgentAppCall(params.id, {
    status: status as AgentAppCallDeviceStatus,
    deviceId: contract.deviceId,
    legacyV1: contract.legacyV1,
    ...(typeof body.claimReceipt === 'string'
      ? { claimReceipt: body.claimReceipt }
      : {}),
    summary,
  })
  if (contract.legacyV1) {
    console.warn('[agent-call] legacy-v1 status contract', {
      callId: params.id,
      legacyDeviceId: contract.deviceId,
      accepted: result.ok,
      sunsetAt: AGENT_APP_CALL_LEGACY_V1_SUNSET_AT,
    })
  }
  if (!result.ok) {
    const httpStatus = result.error === 'not_found' ? 404
      : result.error === 'legacy_contract_sunset' ? 426
        : 409
    return Response.json({ ...result, contractVersion: contract.responseVersion }, { status: httpStatus })
  }
  let noteSaved: boolean | undefined
  if (note) {
    if (result.changed) {
      noteSaved = true
      console.warn('[agent-call] accepted device note', params.id, note)
    } else {
      const appended = await appendAgentAppCallDeviceNote(params.id, {
        deviceId: contract.deviceId,
        legacyV1: contract.legacyV1,
        note,
      })
      noteSaved = appended.ok
      if (appended.ok && appended.changed) {
        console.warn('[agent-call] accepted device note', params.id, note)
      }
    }
  }
  return Response.json({
    ...result,
    contractVersion: contract.responseVersion,
    ...(noteSaved === undefined ? {} : { noteSaved }),
  })
}
