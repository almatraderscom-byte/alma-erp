import { timingSafeEqual } from 'crypto'
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { StudioAccessError } from '@/lib/creative-studio/studio-access'
import {
  assertUnsignedStudioJobCompatibility,
  StudioRunAuthorizationError,
} from '@/lib/creative-studio/studio-run-authorization'
import { assertStudioRunExecutionGate } from '@/lib/creative-studio/studio-run-execution-gate'
import { isPreviewApprovedCreativeStudioImageAction } from '@/lib/creative-studio/preview-worker-scope'

 
const db = prisma as any

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(provided, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: { pendingActionId?: string; paidAttempt?: number }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const pendingActionId = String(body.pendingActionId ?? '').trim()
  if (!pendingActionId) {
    return Response.json({ error: 'pending_action_id_required' }, { status: 422 })
  }

  try {
    const action = await db.agentPendingAction.findUnique({
      where: { id: pendingActionId },
      select: {
        id: true,
        status: true,
        type: true,
        payload: true,
        costEstimate: true,
        createdAt: true,
      },
    })
    if (!action) {
      throw new StudioRunAuthorizationError('run_job_not_approved', 409)
    }
    const payload = asRecord(action.payload)
    const nonPaidLocalCampaign = (
      action.status === 'campaign_approved'
      && action.type === 'image_gen'
      && payload.provider === 'campaign_pack_local'
    )
    const previewApproved = isPreviewApprovedCreativeStudioImageAction(action)
    if (action.status !== 'approved' && !nonPaidLocalCampaign && !previewApproved) {
      throw new StudioRunAuthorizationError('run_job_not_approved', 409)
    }
    // Media mode render-chain jobs: the approved media_plan card IS the spend
    // confirmation. Authorize only when the chain tag round-trips to a real
    // asset row that points back at THIS action and the project is rendering —
    // a forged mediaChain payload on some other row fails this bind.
    const mediaTag = asRecord(payload.mediaChain)
    if (typeof mediaTag.assetId === 'string' && typeof mediaTag.projectId === 'string') {
       
      const mediaDb = prisma as any
      const asset = await mediaDb.agentMediaAsset.findUnique({ where: { id: mediaTag.assetId } })
      const project = asset
        ? await mediaDb.agentMediaProject.findUnique({ where: { id: mediaTag.projectId } })
        : null
      const { isMediaRendering } = await import('@/agent/lib/media/render-chain')
      if (
        asset?.jobId === action.id &&
        asset?.projectId === mediaTag.projectId &&
        isMediaRendering(project?.status)
      ) {
        // legacy:true — the worker's assertStudioRunPaidAttempt accepts the
        // legacy/unsigned contract; without it the first image_gen call dies
        // on a missing paidAttemptLimit and no media project can render.
        return Response.json({ authorized: true, mediaChain: true, legacy: true })
      }
      throw new StudioRunAuthorizationError('media_chain_bind_failed', 409)
    }

    const authorization = asRecord(payload.studioRunAuthorization)
    if (!authorization.receipt) {
      if (
        payload.studioSurface === 'v3'
        || payload.studioRunScope
        || payload.studioPaidAttemptLimit != null
      ) {
        throw new StudioRunAuthorizationError('studio_run_authorization_required', 409)
      }
      const compatibility = assertUnsignedStudioJobCompatibility({
        type: action.type,
        createdAt: action.createdAt,
        payload,
      })
      return Response.json({
        authorized: true,
        legacy: true,
        ...compatibility,
      })
    }
    const claims = await assertStudioRunExecutionGate({
      receipt: authorization.receipt,
      payload,
    })
    if (body.paidAttempt != null) {
      const paidAttempt = Number(body.paidAttempt)
      if (
        !Number.isInteger(paidAttempt)
        || paidAttempt < 1
        || paidAttempt > claims.selection.paidAttemptLimit
      ) {
        throw new StudioRunAuthorizationError('run_attempt_limit_exceeded', 409)
      }
    }
    return Response.json({
      authorized: true,
      receiptId: claims.receiptId,
      maxCostBdt: claims.maxCostBdt,
      paidAttemptLimit: claims.selection.paidAttemptLimit,
      ...(body.paidAttempt == null ? {} : { paidAttempt: body.paidAttempt }),
    })
  } catch (error) {
    const code = error instanceof StudioRunAuthorizationError || error instanceof StudioAccessError
      ? error.code
      : 'run_execution_revalidation_failed'
    const status = error instanceof StudioRunAuthorizationError || error instanceof StudioAccessError
      ? error.status
      : 409
    return Response.json({ error: code }, { status })
  }
}
