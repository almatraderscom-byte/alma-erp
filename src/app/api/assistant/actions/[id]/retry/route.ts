import { timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { appendConfirmCardMessage } from '@/agent/lib/confirm-card-message'
import {
  IMAGE_WORKER_CAPABILITY_KV_KEY,
  imageModelAvailability,
  selectionForImageAction,
} from '@/agent/lib/image-action-contract'
import {
  IMAGE_WORKER_CAPABILITY_V2_KV_KEY,
  parseImageConfigEnvelope,
  readImageWorkerCapabilityV2,
  renderSelectionForAction,
} from '@/agent/lib/image-config-contract'
import { GENERIC_IMAGE_MODELS, type GenericImageModel } from '@/lib/creative-studio/advanced-image-capabilities'
import { isSystemOwner } from '@/lib/roles'
import { readKv } from '@/lib/creative-studio/taste'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

const retryDedupeKey = (sourceActionId: string) => `image-retry:${sourceActionId}`
const retryCardRequestId = (actionId: string) => `image-retry-card:${actionId}`

function chatRetryPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = payload as Record<string, unknown>
  // Creative Studio/campaign/chain payloads carry one-time signed execution
  // authority and have their own retry routes. Never clone those into chat.
  if (
    value.creativeStudio
    || value.campaignPack
    || value.contentPipeline
    || value.familyChain
    || value.chainInternal
    || value.studioRunAuthorization
  ) return null
  const clone = { ...value }
  for (const key of [
    'progressTurnId',
    'executionLease',
    'leaseUntil',
    'jobResultPending',
    'jobResultEnvelope',
    'workerAuthorization',
    // v2: approval embeds the config snapshot into the worker payload. The
    // fresh card is pre-approval again — its canonical config lives in the
    // imageConfig column and is re-embedded by its own approval.
    'imageConfig',
  ]) delete clone[key]
  return clone
}

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

async function authorize(req: NextRequest): Promise<Response | null> {
  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (verifyInternalToken(bearerToken)) return null
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

type ImageRetryRow = {
  id: string
  conversationId: string | null
  type: string
  payload: unknown
  summary: string
  costEstimate: number | null
  status: string
  businessId: string
  imageModel?: string | null
  imageQuote?: unknown
  imageConfig?: unknown
  imageConfigRevision?: number | null
  createdAt: Date | string
}

async function currentImageAvailability() {
  const [workerCapabilities, genericLaneKill, xaiEnabled, workerCapabilitiesV2] = await Promise.all([
    readKv(IMAGE_WORKER_CAPABILITY_KV_KEY),
    readKv('cs_engine_kill:gemini'),
    readKv('cs_xai_enabled'),
    readKv(IMAGE_WORKER_CAPABILITY_V2_KV_KEY),
  ])
  const v2 = readImageWorkerCapabilityV2(workerCapabilitiesV2, Date.now())
  return {
    availability: imageModelAvailability({
      workerCapabilities,
      genericLaneKilled: genericLaneKill === '1',
      xaiConfigured: xaiEnabled === '1',
    }),
    receiptV2: v2.receipt,
    receiptV2Reason: v2.reason,
  }
}

async function responseForRetry(row: ImageRetryRow, sourceActionId: string, idempotent: boolean) {
  if (row.status !== 'pending') {
    return Response.json({
      error: 'retry_already_resolved',
      pendingActionId: row.id,
      status: row.status,
    }, { status: 409 })
  }
  // Existing pinned retry cards remain readable even if the current worker
  // receipt has expired. Approval performs a fresh fail-closed preflight.
  const { availability, receiptV2, receiptV2Reason } = await currentImageAvailability()
  const imageModelSelection = selectionForImageAction({ ...row, availability })
  const imageRenderSelection = renderSelectionForAction({
    ...row,
    availability,
    receipt: receiptV2,
    receiptUnavailableReason: receiptV2Reason || undefined,
  })
  if (row.conversationId) {
    try {
      await appendConfirmCardMessage(row.conversationId, {
        pendingActionId: row.id,
        summary: row.summary,
        actionType: 'image_gen',
        costEstimate: row.costEstimate ?? undefined,
        imageModelSelection,
        imageRenderSelection,
        clientRequestId: retryCardRequestId(row.id),
      })
    } catch (error) {
      console.error('[image-retry] confirm-card persistence failed:', error)
      // The deduped pending action remains intact. Repeating the same tap runs
      // this reconciliation again and cannot create a second card/action.
      return Response.json({
        error: 'retry_card_persist_failed',
        pendingActionId: row.id,
        retryable: true,
      }, { status: 503 })
    }
  }
  return Response.json({
    success: true,
    pendingActionId: row.id,
    sourceActionId,
    idempotent,
    action: {
      id: row.id,
      type: row.type,
      status: row.status,
      summary: row.summary,
      costEstimate: row.costEstimate,
      conversationId: row.conversationId,
      businessId: row.businessId,
      createdAt: row.createdAt,
      imageModelSelection,
      imageRenderSelection,
    },
  })
}

/**
 * Explicit owner retry for a terminal failed chat image. This only creates a
 * fresh pending approval card; it never auto-approves or calls a provider.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const denied = await authorize(req)
  if (denied) return denied

  const { id: sourceActionId } = await props.params
  const dedupeKey = retryDedupeKey(sourceActionId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const existing = await db.agentPendingAction.findUnique({ where: { dedupeKey } })
  if (existing) return responseForRetry(existing, sourceActionId, true)

  // A retry is a new approval card, not merely a history read. Snapshot current
  // worker availability before entering the serializing transaction and refuse
  // to create a card for a model this worker cannot currently execute.
  const { availability, receiptV2 } = await currentImageAvailability()

  let result:
    | { kind: 'created'; row: ImageRetryRow }
    | { kind: 'existing'; row: ImageRetryRow }
    | { kind: 'not_found' }
    | { kind: 'wrong_type'; type: string }
    | { kind: 'wrong_status'; status: string }
    | { kind: 'unsupported_lane' }
    | { kind: 'unavailable'; message: string }
    | { kind: 'open'; row: { id: string; type: string; status: string } }
  try {
    result = await db.$transaction(async (tx: typeof db) => {
      const source = await tx.agentPendingAction.findUnique({ where: { id: sourceActionId } })
      if (!source) return { kind: 'not_found' as const }
      if (source.type !== 'image_gen') return { kind: 'wrong_type' as const, type: source.type }
      if (source.status !== 'failed') return { kind: 'wrong_status' as const, status: source.status }
      const retryPayload = chatRetryPayload(source.payload)
      if (
        !source.conversationId
        || !retryPayload
        || typeof source.imageModel !== 'string'
        || !GENERIC_IMAGE_MODELS.includes(source.imageModel as GenericImageModel)
        || !source.imageQuote
        || typeof source.imageQuote !== 'object'
      ) return { kind: 'unsupported_lane' as const }
      // A v2 source proves availability through the live v2 receipt for its
      // exact preset/tier; poster (2:3) has no v1 selection at all. Legacy
      // sources keep the v1 selection check unchanged.
      const sourceEnvelope = parseImageConfigEnvelope(source.imageConfig, source.imageModel)
      if (sourceEnvelope) {
        const supported = receiptV2
          && receiptV2.models.includes(source.imageModel as never)
          && (receiptV2.presets[source.imageModel]?.[sourceEnvelope.config.presetId] ?? [])
            .includes(sourceEnvelope.config.imageSize)
        const killed = availability[source.imageModel]
        if (!supported || (typeof killed === 'string' && killed)) {
          return {
            kind: 'unavailable' as const,
            message: typeof killed === 'string' && killed
              ? killed
              : 'Live image worker has not proven this model/preset/size combination.',
          }
        }
      } else {
        const selection = selectionForImageAction({ ...source, availability })
        const selectedOption = selection?.options.find((option) => option.id === source.imageModel)
        if (!selection || !selectedOption?.enabled) {
          return {
            kind: 'unavailable' as const,
            message: selectedOption?.unavailableReason ?? 'Image model is unavailable on the active worker.',
          }
        }
      }

      // Serialize the predicate ("no pending card in this conversation") so
      // retries of two different failed source cards cannot both pass it.
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${source.conversationId}))::text AS lock_token
      `)

      const duplicate = await tx.agentPendingAction.findUnique({ where: { dedupeKey } })
      if (duplicate) return { kind: 'existing' as const, row: duplicate }

      if (source.conversationId) {
        const open = await tx.agentPendingAction.findFirst({
          where: { conversationId: source.conversationId, status: 'pending' },
          select: { id: true, type: true, status: true },
          orderBy: { createdAt: 'asc' },
        })
        if (open) return { kind: 'open' as const, row: open }
      }

      const row = await tx.agentPendingAction.create({
        data: {
          conversationId: source.conversationId,
          dedupeKey,
          type: 'image_gen',
          // Generation inputs, selected model and quote are an immutable retry
          // snapshot. Worker/progress bookkeeping lives outside these fields.
          payload: retryPayload,
          summary: source.summary,
          costEstimate: source.costEstimate,
          status: 'pending',
          businessId: source.businessId,
          ownerDecided: null,
          imageModel: source.imageModel,
          imageQuote: source.imageQuote,
          // v2: the fresh card copies the exact canonical selection and starts
          // its own revision history — editable again before its own approval.
          ...(sourceEnvelope
            ? { imageConfig: source.imageConfig, imageConfigRevision: 0 }
            : {}),
        },
      })
      return { kind: 'created' as const, row }
    })
  } catch (error) {
    // The unique retry source key is the final double-tap/concurrency guard.
    if ((error as { code?: string })?.code !== 'P2002') throw error
    const duplicate = await db.agentPendingAction.findUnique({ where: { dedupeKey } })
    if (!duplicate) throw error
    result = { kind: 'existing', row: duplicate }
  }

  if (result.kind === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
  if (result.kind === 'wrong_type') {
    return Response.json({ error: 'not_image_action', type: result.type }, { status: 422 })
  }
  if (result.kind === 'wrong_status') {
    return Response.json({ error: 'retry_requires_failed', status: result.status }, { status: 409 })
  }
  if (result.kind === 'unsupported_lane') {
    return Response.json({ error: 'image_retry_not_supported' }, { status: 422 })
  }
  if (result.kind === 'unavailable') {
    return Response.json({
      error: 'image_model_unavailable',
      message: result.message,
      retryable: true,
    }, { status: 422 })
  }
  if (result.kind === 'open') {
    return Response.json({
      error: 'open_card_exists',
      openActionId: result.row.id,
      openActionType: result.row.type,
      status: result.row.status,
    }, { status: 409 })
  }
  return responseForRetry(result.row, sourceActionId, result.kind === 'existing')
}
