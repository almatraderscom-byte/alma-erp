/**
 * Phase V4 — multi-clip Veo reels (owner-initiated only, cost shown up front).
 *
 * A 16–24s generated reel = 2–3 Veo clips of 8s, each with its OWN scene-pool
 * scene (variety rule), stitched by the ffmpeg worker with a crossfade. Same
 * assembly-line pattern as the family chain: each finished clip queues the
 * next via the job-result hook; the last one queues a veoConcat video_edit.
 */
import { prisma } from '@/lib/prisma'
import { buildVideoBrief, estimateReelCostUsd } from '@/lib/content-engine/video-brief'
import { pickScene } from '@/lib/tryon/scene-pool'
import {
  currentStudioRunExecutionContext,
  recoveredStudioRunJobId,
  studioRunAuthorizedJobFields,
} from '@/lib/creative-studio/studio-run-context'
import type { StudioRunEstimateReceiptClaims } from '@/lib/creative-studio/studio-run-authorization'
import { assertStudioRunExecutionGate } from '@/lib/creative-studio/studio-run-execution-gate'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const VEO_CLIP_SEC = 8
export const VEO_FADE_SEC = 0.4

export type VeoChainState = {
  veoChain: true
  chainId: string
  index: number
  totalClips: number
  clipSec: number
  aspect: '9:16' | '16:9'
  productImagePath: string
  vibe: 'premium' | 'festival' | 'offer' | 'lifestyle'
  clipPaths: string[]
  runAuthorization: {
    claims: StudioRunEstimateReceiptClaims
    receipt: string
  }
}

export function multiReelCostUsd(clips: number): number {
  return Math.round(clips * estimateReelCostUsd(VEO_CLIP_SEC) * 100) / 100
}

function clipAction(state: VeoChainState) {
  const picked = pickScene()
  const { prompt } = buildVideoBrief(
    { productCode: 'studio-reel', name: null, category: null, fabric: null, imagePath: state.productImagePath, familyMatch: false },
    { vibe: state.vibe, aspect: state.aspect, durationSec: state.clipSec },
  )
  return {
    conversationId: null,
    type: 'video_gen',
    payload: {
      prompt: `${prompt} Scene ${state.index + 1} of ${state.totalClips}: ${picked.scene.prompt}`,
      referenceImageId: state.productImagePath,
      durationSec: state.clipSec,
      creativeStudio: true,
      skipTelegramCard: true,
      studioMode: 'image_to_video',
      provider: 'gemini',
      ...state,
    },
    summary: `🎬 লম্বা রিল — ক্লিপ ${state.index + 1}/${state.totalClips}`,
    costEstimate: estimateReelCostUsd(state.clipSec),
    status: 'approved',
  }
}

async function recoverAuthorizedAction(
  authorized: { dedupeKey: string; payload: Record<string, unknown> },
): Promise<string | null> {
  const existing = await db.agentPendingAction.findUnique({
    where: { dedupeKey: authorized.dedupeKey },
    select: {
      id: true,
      status: true,
      dedupeKey: true,
      payload: true,
    },
  })
  return recoveredStudioRunJobId({
    existing,
    dedupeKey: authorized.dedupeKey,
    payload: authorized.payload,
  })
}

export async function startVeoReelChain(input: {
  productImagePath: string
  totalClips: number
  aspect: '9:16' | '16:9'
  vibe?: VeoChainState['vibe']
}): Promise<{ pendingActionId: string; costUsd: number }> {
  const execution = currentStudioRunExecutionContext()
  if (!execution) throw new Error('studio_run_authorization_required')
  const state: VeoChainState = {
    veoChain: true,
    chainId: `${execution.claims.receiptId}:veo`,
    index: 0,
    totalClips: Math.min(3, Math.max(2, input.totalClips)),
    clipSec: VEO_CLIP_SEC,
    aspect: input.aspect,
    productImagePath: input.productImagePath,
    vibe: input.vibe ?? 'premium',
    clipPaths: [],
    runAuthorization: {
      claims: execution.claims,
      receipt: execution.receipt,
    },
  }
  const action = clipAction(state)
  const authorized = studioRunAuthorizedJobFields(action.payload, {
    claims: state.runAuthorization.claims,
    receipt: state.runAuthorization.receipt,
    dedupePart: `veo:${state.chainId}:${state.index}`,
  })
  const recoveredId = await recoverAuthorizedAction(authorized)
  if (recoveredId) {
    return {
      pendingActionId: recoveredId,
      costUsd: multiReelCostUsd(state.totalClips),
    }
  }
  await assertStudioRunExecutionGate({
    receipt: state.runAuthorization.receipt,
    payload: authorized.payload,
    expectedClaims: state.runAuthorization.claims,
  })
  const row = await db.agentPendingAction.upsert({
    where: { dedupeKey: authorized.dedupeKey },
    create: { ...action, dedupeKey: authorized.dedupeKey, payload: authorized.payload },
    update: {},
  })
  return { pendingActionId: row.id as string, costUsd: multiReelCostUsd(state.totalClips) }
}

/** Called from the job-result hook when a chain clip finishes. */
export async function advanceVeoChain(
  action: { payload: unknown },
  storagePath: string | undefined,
): Promise<string | null> {
  const p = action.payload as VeoChainState
  if (!p?.veoChain || !storagePath) return null
  const clipPaths = [...(p.clipPaths ?? []), storagePath]

  if (clipPaths.length < p.totalClips) {
    const next: VeoChainState = { ...p, index: clipPaths.length, clipPaths }
    const action = clipAction(next)
    const authorized = studioRunAuthorizedJobFields(action.payload, {
      claims: next.runAuthorization.claims,
      receipt: next.runAuthorization.receipt,
      dedupePart: `veo:${next.chainId}:${next.index}`,
    })
    const recoveredId = await recoverAuthorizedAction(authorized)
    if (recoveredId) return recoveredId
    await assertStudioRunExecutionGate({
      receipt: next.runAuthorization.receipt,
      payload: authorized.payload,
      expectedClaims: next.runAuthorization.claims,
    })
    const row = await db.agentPendingAction.upsert({
      where: { dedupeKey: authorized.dedupeKey },
      create: { ...action, dedupeKey: authorized.dedupeKey, payload: authorized.payload },
      update: {},
    })
    return row.id as string
  }

  // all clips done → one ffmpeg crossfade-concat job on the worker
  const concatPayload = {
    videoEdit: true,
    creativeStudio: true,
    skipTelegramCard: true,
    studioMode: 'video_edit',
    provider: 'ffmpeg',
    veoConcat: true,
    concatPaths: clipPaths,
    fadeSec: VEO_FADE_SEC,
    aspect: p.aspect,
    videoName: 'veo-multi-reel',
    recipeId: 'veo_concat',
    targetSec: p.totalClips * p.clipSec,
  }
  const authorized = studioRunAuthorizedJobFields(concatPayload, {
    claims: p.runAuthorization.claims,
    receipt: p.runAuthorization.receipt,
    dedupePart: `veo:${p.chainId}:concat`,
  })
  const recoveredId = await recoverAuthorizedAction(authorized)
  if (recoveredId) return recoveredId
  const row = await db.agentPendingAction.upsert({
    where: { dedupeKey: authorized.dedupeKey },
    create: {
      conversationId: null,
      dedupeKey: authorized.dedupeKey,
      type: 'video_edit',
      payload: authorized.payload,
      summary: `🎬 লম্বা রিল — ${p.totalClips} ক্লিপ জোড়া লাগছে`,
      costEstimate: 0,
      status: 'approved',
    },
    update: {},
  })
  return row.id as string
}
