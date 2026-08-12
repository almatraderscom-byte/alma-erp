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
  createdAt: Date | string
}

async function currentImageAvailability() {
  const [workerCapabilities, genericLaneKill, xaiEnabled] = await Promise.all([
    readKv(IMAGE_WORKER_CAPABILITY_KV_KEY),
    readKv('cs_engine_kill:gemini'),
    readKv('cs_xai_enabled'),
  ])
  return imageModelAvailability({
    workerCapabilities,
    genericLaneKilled: genericLaneKill === '1',
    xaiConfigured: xaiEnabled === '1',
  })
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
  const availability = await currentImageAvailability()
  const imageModelSelection = selectionForImageAction({ ...row, availability })
  if (row.conversationId) {
    try {
      await appendConfirmCardMessage(row.conversationId, {
        pendingActionId: row.id,
        summary: row.summary,
        actionType: 'image_gen',
        costEstimate: row.costEstimate ?? undefined,
        imageModelSelection,
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
  const availability = await currentImageAvailability()

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
      const selection = selectionForImageAction({ ...source, availability })
      const selectedOption = selection?.options.find((option) => option.id === source.imageModel)
      if (!selection || !selectedOption?.enabled) {
        return {
          kind: 'unavailable' as const,
          message: selectedOption?.unavailableReason ?? 'Image model is unavailable on the active worker.',
        }
      }

      // Serialize the predicate ("no pending card in this conversation") so
      // retries of two different failed source cards cannot both pass it.
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${source.conversationId}))
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
