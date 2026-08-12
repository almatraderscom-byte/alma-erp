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
  buildImageRenderSelection,
  IMAGE_CONTROLS_V2_KV_KEY,
  imageRenderConfigForAction,
  imageRenderPayloadMirror,
  normalizeImagePresetId,
  resolveImageRenderConfig,
  buildImageRenderQuote,
  type ImageRenderSelection,
} from '@/agent/lib/image-render-config'
import {
  normalizeImageActionCount,
  normalizeImageActionQuality,
  normalizeImageActionSize,
} from '@/agent/lib/image-action-contract'
import {
  GENERIC_IMAGE_MODELS,
  type GenericImageModel,
} from '@/lib/creative-studio/advanced-image-capabilities'
import { readKv } from '@/lib/creative-studio/taste'

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

  const [workerCapabilities, genericLaneKill, xaiEnabled] = action.type === 'image_gen'
    ? await Promise.all([
        readKv(IMAGE_WORKER_CAPABILITY_KV_KEY),
        readKv('cs_engine_kill:gemini'),
        readKv('cs_xai_enabled'),
      ])
    : [null, null, null]
  const availability = imageModelAvailability({
    workerCapabilities,
    genericLaneKilled: genericLaneKill === '1',
    xaiConfigured: xaiEnabled === '1',
  })

  return Response.json({
    id: action.id,
    type: action.type,
    summary: action.summary,
    status: action.status,
    isFinance: isFinanceConfirmType(action.type),
    entryCount: getEntryCount(action),
    editFields: financeEditFieldsForType(action.type),
    ...(action.type === 'image_gen'
      ? {
          imageModelSelection: selectionForImageAction({ ...action, availability }),
          imageRenderSelection: await imageRenderSelectionForAction(action, availability),
        }
      : {}),
  })
}

/**
 * The v2 projection rides beside v1, never in place of it: Build 102's decoder
 * validates version 1 and must keep decoding. Advertised only while the owner
 * flag is on; the canonical config itself persists regardless, so already
 * pinned rows stay readable if the flag is rolled back.
 */
async function imageRenderSelectionForAction(
  action: {
    imageModel?: string | null
    imageConfig?: unknown
    imageConfigRevision?: number
    payload: unknown
  },
  availability: ReturnType<typeof imageModelAvailability>,
): Promise<ImageRenderSelection | null> {
  if ((await readKv(IMAGE_CONTROLS_V2_KV_KEY)) !== '1') return null
  const config = imageRenderConfigForAction(action)
  if (!config) return null
  try {
    return buildImageRenderSelection({
      config,
      revision: action.imageConfigRevision ?? 0,
      availability,
    })
  } catch { return null }
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
  if (action.type === 'image_gen' && body.imageConfig !== undefined) {
    return editImageRenderConfig(db, action, body.imageConfig, params.id)
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
    // The legacy Build-102 edit rides the SAME revision counter as the v2
    // editor: it snapshots the revision it read, so a concurrent v2 edit wins
    // or loses atomically and can never be partially overwritten.
    const legacyConfig = imageRenderConfigForAction({ ...action, imageModel })
    const selected = await db.agentPendingAction.updateMany({
      where: {
        id: params.id,
        status: 'pending',
        approvalClaimedAt: null,
        imageModel: action.imageModel ?? null,
        imageConfigRevision: action.imageConfigRevision ?? 0,
      },
      data: {
        imageModel,
        imageQuote,
        summary,
        imageConfigRevision: (action.imageConfigRevision ?? 0) + 1,
        // Keep the canonical config coherent with the new model when this row
        // already carries one; a fresh v1-only row stays v1 until staged as v2.
        ...(action.imageConfig != null && legacyConfig ? { imageConfig: legacyConfig } : {}),
      },
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
 * v2 professional setup edit. One compare-and-set writes the canonical config,
 * its incremented revision, the payload mirror the worker renders from, the
 * requote and the summary — atomically, guarded on the exact revision the
 * editor saw plus the pending/unclaimed row state. Approval claims the same
 * row, so whichever wins first excludes the other; no paid queue entry can be
 * built from a half-updated selection.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function editImageRenderConfig(db: any, action: any, rawConfig: unknown, id: string) {
  if ((await readKv(IMAGE_CONTROLS_V2_KV_KEY)) !== '1') {
    return Response.json({ error: 'image_controls_v2_disabled' }, { status: 409 })
  }
  const request = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig as Record<string, unknown>
    : null
  if (!request) return Response.json({ error: 'invalid_image_config' }, { status: 422 })
  const expectedRevision = Number(request.expectedRevision)
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return Response.json({ error: 'invalid_image_config', field: 'expectedRevision' }, { status: 422 })
  }
  const current = imageRenderConfigForAction(action)
  if (!current) return Response.json({ error: 'image_config_unavailable' }, { status: 422 })
  const model = request.imageModel === undefined
    ? current.model
    : (typeof request.imageModel === 'string'
        && GENERIC_IMAGE_MODELS.includes(request.imageModel as GenericImageModel)
      ? request.imageModel as GenericImageModel
      : null)
  if (!model) return Response.json({ error: 'invalid_image_config', field: 'imageModel' }, { status: 422 })

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
  const unavailableReason = availability[model]
  if (typeof unavailableReason === 'string' && unavailableReason) {
    return Response.json(
      { error: 'image_model_unavailable', message: unavailableReason }, { status: 422 })
  }

  let config
  try {
    config = resolveImageRenderConfig({
      model,
      presetId: normalizeImagePresetId(
        request.presetId ?? current.presetId, current.aspectRatio),
      imageSize: request.imageSize === undefined
        ? current.imageSize : normalizeImageActionSize(request.imageSize),
      quality: request.quality === undefined
        ? current.quality : normalizeImageActionQuality(request.quality),
      variationCount: request.variationCount === undefined
        ? current.variationCount : normalizeImageActionCount(request.variationCount),
      pipelineMode: current.pipelineMode,
    })
  } catch (error) {
    const message = error instanceof Error
      ? error.message.replace(/^image_(config_invalid|model_incompatible):/, '')
      : String(error)
    return Response.json({ error: 'image_config_incompatible', message }, { status: 422 })
  }

  const quote = buildImageRenderQuote(config)
  const payload = imageRenderPayloadMirror(
    action.payload as Record<string, unknown>, config)
  const summary = buildImageActionSummary({
    prompt: (action.payload as Record<string, unknown>).prompt,
    quality: config.quality,
    count: config.variationCount,
    model: config.model,
  })
  const selected = await db.agentPendingAction.updateMany({
    where: {
      id,
      status: 'pending',
      approvalClaimedAt: null,
      imageConfigRevision: expectedRevision,
    },
    data: {
      imageModel: config.model,
      imageConfig: config,
      imageConfigRevision: expectedRevision + 1,
      imageQuote: quote,
      payload,
      summary,
    },
  })
  if (selected.count === 0) {
    const fresh = await db.agentPendingAction.findUnique({ where: { id } })
    const freshConfig = fresh ? imageRenderConfigForAction(fresh) : null
    return Response.json({
      error: fresh?.status === 'pending' ? 'image_config_changed' : 'already_resolved',
      status: fresh?.status,
      imageRenderSelection: freshConfig
        ? buildImageRenderSelection({
            config: freshConfig,
            revision: fresh?.imageConfigRevision ?? 0,
            availability,
          })
        : null,
    }, { status: 409 })
  }
  return Response.json({
    success: true,
    id,
    type: action.type,
    status: 'pending',
    summary,
    imageRenderSelection: buildImageRenderSelection({
      config,
      revision: expectedRevision + 1,
      availability,
    }),
  })
}
