import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import {
  applyFinanceFieldEdit,
  financeEditFieldsForType,
  getEntryCount,
  isFinanceConfirmType,
  removeBatchEntry,
  rebuildFinanceSummary,
} from '@/agent/lib/finance-pending'
import {
  formatExpenseLineSummary,
  formatLedgerLineSummary,
} from '@/agent/lib/finance-shared'
import {
  buildImageActionQuote,
  buildImageActionSummary,
  buildImageModelSelection,
  IMAGE_WORKER_CAPABILITY_KV_KEY,
  imageActionInputs,
  imageModelAvailability,
  selectionForImageAction,
} from '@/agent/lib/image-action-contract'
import {
  IMAGE_PRESETS,
  IMAGE_WORKER_CAPABILITY_V2_KV_KEY,
  buildImageConfigEnvelope,
  buildImageRenderConfig,
  parseImageConfigEnvelope,
  payloadMirrorFromConfig,
  readImageWorkerCapabilityV2,
  receiptSupports,
  renderSelectionForAction,
  type ImagePresetId,
} from '@/agent/lib/image-config-contract'
import {
  GENERIC_IMAGE_MODELS,
  type GenericImageModel,
} from '@/lib/creative-studio/advanced-image-capabilities'
import { readKv } from '@/lib/creative-studio/taste'
import {
  approvalConversationId,
  progressTurnIdFromApprovalPayload,
} from '@/agent/lib/approval-progress-context'

export const runtime = 'nodejs'

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = _req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req: _req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const action = await (prisma as any).agentPendingAction.findUnique({ where: { id: params.id } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })

  // Action-bound progress identity for native approval docks. Never trust the
  // payload reference alone: only expose it when that exact turn belongs to
  // this action's conversation. Cross-card/cross-conversation references fail
  // closed to null rather than leaking an unrelated live activity.
  const conversationId = approvalConversationId(action)
  const referencedProgressTurnId = progressTurnIdFromApprovalPayload(action.payload)
  const progressTurn = conversationId && referencedProgressTurnId
    ? await (prisma as any).agentTurn.findFirst({
        where: { id: referencedProgressTurnId, conversationId },
        select: { id: true, conversationId: true, status: true },
      })
    : null

  const [workerCapabilities, genericLaneKill, xaiEnabled, workerCapabilitiesV2] = action.type === 'image_gen'
    ? await Promise.all([
        readKv(IMAGE_WORKER_CAPABILITY_KV_KEY),
        readKv('cs_engine_kill:gemini'),
        readKv('cs_xai_enabled'),
        readKv(IMAGE_WORKER_CAPABILITY_V2_KV_KEY),
      ])
    : [null, null, null, null]
  const availability = imageModelAvailability({
    workerCapabilities,
    genericLaneKilled: genericLaneKill === '1',
    xaiConfigured: xaiEnabled === '1',
  })
  const { receipt: receiptV2, reason: receiptV2Reason } = readImageWorkerCapabilityV2(
    workerCapabilitiesV2, Date.now())

  return Response.json({
    id: action.id,
    type: action.type,
    summary: action.summary,
    status: action.status,
    conversationId,
    progressTurnId: progressTurn?.id ?? null,
    progressConversationId: progressTurn?.conversationId ?? null,
    progressTurnStatus: progressTurn?.status ?? null,
    isFinance: isFinanceConfirmType(action.type),
    entryCount: getEntryCount(action),
    editFields: financeEditFieldsForType(action.type),
    ...(action.type === 'image_gen'
      ? {
          imageModelSelection: selectionForImageAction({ ...action, availability }),
          imageRenderSelection: renderSelectionForAction({
            ...action,
            availability,
            receipt: receiptV2,
            receiptUnavailableReason: receiptV2Reason || undefined,
          }),
        }
      : {}),
  })
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: {
    removeEntryIndex?: number
    field?: string
    value?: unknown
    convertToSingle?: boolean
    imageModel?: unknown
    imageConfig?: unknown
  }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const action = await db.agentPendingAction.findUnique({ where: { id: params.id } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })
  if (action.status !== 'pending') {
    return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
  }
  // ── Build 103 Issue 2: revisioned multi-field edit (v2 cards only) ────────
  if (action.type === 'image_gen' && body.imageConfig !== undefined) {
    return applyImageConfigEdit(db, action, body.imageConfig)
  }
  // Legacy Build 102 model-only edit on a v2 card routes through the SAME v2
  // canonical compare-and-set (snapshot the read revision) — it can never
  // bypass a concurrent v2 edit or a claimed approval.
  if (
    action.type === 'image_gen'
    && body.imageModel !== undefined
    && action.imageConfig != null
  ) {
    const currentEnvelope = parseImageConfigEnvelope(action.imageConfig, action.imageModel)
    if (!currentEnvelope) {
      // A half-written v2 card must not accept blind edits — fail closed
      // without mutating; approval performs the same divergence check.
      return Response.json({ error: 'image_config_divergent' }, { status: 409 })
    }
    return applyImageConfigEdit(db, action, {
      expectedRevision: action.imageConfigRevision ?? 0,
      imageModel: body.imageModel,
      presetId: currentEnvelope.config.presetId,
      imageSize: currentEnvelope.config.imageSize,
      quality: currentEnvelope.config.quality,
      variationCount: currentEnvelope.config.variationCount,
    })
  }
  if (action.type === 'image_gen' && body.imageModel !== undefined) {
    if (
      typeof body.imageModel !== 'string'
      || !GENERIC_IMAGE_MODELS.includes(body.imageModel as GenericImageModel)
    ) {
      return Response.json({ error: 'invalid_image_model' }, { status: 422 })
    }
    const imageModel = body.imageModel as GenericImageModel
    const inputs = imageActionInputs(action.payload)
    const [workerCapabilities, genericLaneKill, xaiEnabled] = await Promise.all([
      readKv(IMAGE_WORKER_CAPABILITY_KV_KEY),
      readKv('cs_engine_kill:gemini'),
      readKv('cs_xai_enabled'),
    ])
    const availability = imageModelAvailability({
      workerCapabilities,
      genericLaneKilled: genericLaneKill === '1',
      xaiConfigured: xaiEnabled === '1',
    })
    let imageQuote
    let imageModelSelection
    try {
      imageQuote = buildImageActionQuote({ model: imageModel, ...inputs })
      imageModelSelection = buildImageModelSelection({ selectedModel: imageModel, ...inputs, availability })
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^image_model_incompatible:/, '') : String(error)
      return Response.json({ error: 'image_model_incompatible', message }, { status: 422 })
    }
    const payload = action.payload as Record<string, unknown>
    const summary = buildImageActionSummary({
      prompt: payload.prompt,
      quality: inputs.quality,
      count: inputs.requestedImages,
      model: imageModel,
    })
    // One compare-and-set writes the independent selection fields. Approval
    // claims the same pending row; whichever obtains the row lock first wins,
    // so a model change can never mutate an already-approved worker payload.
    const selected = await db.agentPendingAction.updateMany({
      where: {
        id: params.id,
        status: 'pending',
        approvalClaimedAt: null,
        imageModel: action.imageModel ?? null,
      },
      data: { imageModel, imageQuote, summary },
    })
    if (selected.count === 0) {
      const current = await db.agentPendingAction.findUnique({ where: { id: params.id } })
      return Response.json({
        error: current?.status === 'pending' ? 'image_model_changed' : 'already_resolved',
        status: current?.status,
        imageModelSelection: current
          ? selectionForImageAction({ ...current, availability })
          : null,
      }, { status: 409 })
    }
    return Response.json({
      success: true,
      id: action.id,
      type: action.type,
      status: 'pending',
      summary,
      imageModelSelection,
    })
  }
  if (!isFinanceConfirmType(action.type)) {
    return Response.json({ error: 'not_finance_action' }, { status: 400 })
  }

  let newType = action.type as string
  let newPayload = action.payload as Record<string, unknown>
  let newSummary = action.summary as string

  if (body.removeEntryIndex !== undefined) {
    const result = removeBatchEntry(action, Number(body.removeEntryIndex))
    if ('error' in result) return Response.json({ error: result.error }, { status: 400 })
    newPayload = result.payload
    newSummary = result.summary

    const entries = newPayload.entries as unknown[] | undefined
    if (!entries && newPayload.personName) {
      newType = 'log_ledger_entry'
    } else if (!entries && newPayload.amount && newPayload.note) {
      newType = 'log_expense'
    } else if (Array.isArray(entries) && entries.length === 1) {
      const e = entries[0] as Record<string, unknown>
      if (action.type.startsWith('log_ledger')) {
        newType = 'log_ledger_entry'
        newPayload = {
          personName: e.personName,
          direction: e.direction,
          amount: e.amount,
          currency: e.currency || 'BDT',
          note: e.note ?? null,
          occurredAt: e.occurredAt || new Date().toISOString(),
        }
        newSummary = formatLedgerLineSummary(
          String(newPayload.personName),
          String(newPayload.direction),
          Number(newPayload.amount),
          String(newPayload.currency),
          newPayload.note as string | null,
        )
      } else {
        newType = 'log_expense'
        newPayload = {
          amount: e.amount,
          currency: e.currency || 'BDT',
          category: e.category ?? null,
          note: e.note ?? 'খরচ',
          occurredAt: e.occurredAt || new Date().toISOString(),
        }
        newSummary = formatExpenseLineSummary(
          Number(newPayload.amount),
          String(newPayload.currency),
          String(newPayload.note),
          newPayload.category as string | null,
        )
      }
    }
  } else if (body.field && body.value !== undefined) {
    const result = applyFinanceFieldEdit(action, String(body.field), body.value)
    if ('error' in result) return Response.json({ error: result.error }, { status: 400 })
    newPayload = result.payload
    newSummary = result.summary
  } else {
    return Response.json({ error: 'nothing_to_patch' }, { status: 400 })
  }

  const updated = await db.agentPendingAction.update({
    where: { id: params.id },
    data: { type: newType, payload: newPayload, summary: newSummary },
  })

  return Response.json({
    success: true,
    id: updated.id,
    type: updated.type,
    summary: updated.summary,
    entryCount: getEntryCount(updated),
    isFinance: true,
    isBatch: updated.type === 'log_ledger_entries_batch' || updated.type === 'log_expenses_batch',
  })
}

/**
 * Build 103 Issue 2 — the atomic multi-field image edit. One revisioned
 * compare-and-set writes the canonical envelope, the payload mirror, the v1
 * mirror quote, and the summary together; approval claims the same row, so
 * whichever wins first excludes the other completely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyImageConfigEdit(db: any, action: any, rawInput: unknown): Promise<Response> {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return Response.json({ error: 'invalid_image_config', field: 'imageConfig' }, { status: 422 })
  }
  const input = rawInput as Record<string, unknown>
  const expectedRevision = input.expectedRevision
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return Response.json({ error: 'invalid_image_config', field: 'expectedRevision' }, { status: 422 })
  }
  if (
    typeof input.imageModel !== 'string'
    || !GENERIC_IMAGE_MODELS.includes(input.imageModel as GenericImageModel)
  ) {
    return Response.json({ error: 'invalid_image_config', field: 'imageModel' }, { status: 422 })
  }
  const model = input.imageModel as GenericImageModel
  if (typeof input.presetId !== 'string' || !IMAGE_PRESETS.some((p) => p.id === input.presetId)) {
    return Response.json({ error: 'invalid_image_config', field: 'presetId' }, { status: 422 })
  }
  const presetId = input.presetId as ImagePresetId
  if (input.imageSize !== '1K' && input.imageSize !== '2K' && input.imageSize !== '4K') {
    return Response.json({ error: 'invalid_image_config', field: 'imageSize' }, { status: 422 })
  }
  const imageSize = input.imageSize
  if (input.quality !== 'standard' && input.quality !== 'pro') {
    return Response.json({ error: 'invalid_image_config', field: 'quality' }, { status: 422 })
  }
  const quality = input.quality
  if (
    typeof input.variationCount !== 'number'
    || !Number.isInteger(input.variationCount)
    || input.variationCount < 1
    || input.variationCount > 4
  ) {
    return Response.json({ error: 'invalid_image_config', field: 'variationCount' }, { status: 422 })
  }
  const variationCount = input.variationCount

  // A v2 edit is only defined for a v2 card. (Legacy cards keep the v1 path.)
  const currentEnvelope = parseImageConfigEnvelope(action.imageConfig, action.imageModel)
  if (!currentEnvelope) {
    return Response.json({ error: 'image_config_unsupported' }, { status: 422 })
  }

  // Fresh worker proof + owner kill switches — never enable from source code.
  const [workerCapabilities, genericLaneKill, xaiEnabled, workerCapabilitiesV2] = await Promise.all([
    readKv(IMAGE_WORKER_CAPABILITY_KV_KEY),
    readKv('cs_engine_kill:gemini'),
    readKv('cs_xai_enabled'),
    readKv(IMAGE_WORKER_CAPABILITY_V2_KV_KEY),
  ])
  const availability = imageModelAvailability({
    workerCapabilities,
    genericLaneKilled: genericLaneKill === '1',
    xaiConfigured: xaiEnabled === '1',
  })
  const { receipt: receiptV2, reason: receiptV2Reason } = readImageWorkerCapabilityV2(
    workerCapabilitiesV2, Date.now())
  const killReason = availability[model]
  if (typeof killReason === 'string' && killReason) {
    return Response.json({
      error: 'image_model_incompatible', field: 'imageModel', message: killReason,
    }, { status: 422 })
  }
  if (!receiptSupports(receiptV2, model, presetId, imageSize)) {
    return Response.json({
      error: 'image_model_incompatible',
      field: 'imageModel',
      message: receiptV2
        ? 'Live image worker has not proven this model/preset/size combination.'
        : receiptV2Reason,
    }, { status: 422 })
  }

  let config
  let envelope
  try {
    config = buildImageRenderConfig({
      model,
      presetId,
      imageSize,
      quality,
      variationCount,
      pipelineMode: currentEnvelope.config.pipelineMode,
    })
    envelope = buildImageConfigEnvelope(model, config)
  } catch (error) {
    const message = error instanceof Error
      ? error.message.replace(/^image_config_incompatible:/, '')
      : String(error)
    return Response.json({ error: 'image_model_incompatible', message }, { status: 422 })
  }

  // v1 mirror quote keeps an installed Build 102 rendering a coherent card;
  // poster (2:3) has no v1 projection and mirrors as null.
  let v1Quote: unknown = null
  try {
    v1Quote = buildImageActionQuote({
      model,
      quality,
      imageSize,
      requestedImages: variationCount,
      pipelineMode: config.pipelineMode,
      aspectRatio: config.aspectRatio,
    })
  } catch { v1Quote = null }

  const payload = (action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload))
    ? action.payload as Record<string, unknown>
    : {}
  const summary = buildImageActionSummary({
    prompt: payload.prompt,
    quality,
    count: variationCount,
    model,
  })
  const nextPayload = {
    ...payload,
    ...payloadMirrorFromConfig(model, config),
  }

  const selected = await db.agentPendingAction.updateMany({
    where: {
      id: action.id,
      status: 'pending',
      approvalClaimedAt: null,
      imageConfigRevision: expectedRevision,
    },
    data: {
      imageConfig: envelope,
      imageConfigRevision: expectedRevision + 1,
      imageModel: model,
      imageQuote: v1Quote,
      summary,
      payload: nextPayload,
    },
  })
  if (selected.count === 0) {
    const current = await db.agentPendingAction.findUnique({ where: { id: action.id } })
    return Response.json({
      error: current?.status === 'pending' ? 'image_config_conflict' : 'already_resolved',
      status: current?.status,
      imageRenderSelection: current
        ? renderSelectionForAction({
            ...current,
            availability,
            receipt: receiptV2,
            receiptUnavailableReason: receiptV2Reason || undefined,
          })
        : null,
      imageModelSelection: current
        ? selectionForImageAction({ ...current, availability })
        : null,
    }, { status: 409 })
  }

  const updated = {
    ...action,
    imageConfig: envelope,
    imageConfigRevision: expectedRevision + 1,
    imageModel: model,
    imageQuote: v1Quote,
    payload: nextPayload,
  }
  return Response.json({
    success: true,
    id: action.id,
    type: action.type,
    status: 'pending',
    summary,
    imageRenderSelection: renderSelectionForAction({
      ...updated,
      availability,
      receipt: receiptV2,
      receiptUnavailableReason: receiptV2Reason || undefined,
    }),
    imageModelSelection: selectionForImageAction({ ...updated, availability }),
  })
}
