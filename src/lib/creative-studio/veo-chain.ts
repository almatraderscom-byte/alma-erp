/**
 * Phase V4 — multi-clip Veo reels (owner-initiated only, cost shown up front).
 *
 * A 16–24s generated reel = 2–3 Veo clips of 8s, each with its OWN scene-pool
 * scene (variety rule), stitched by the ffmpeg worker with a crossfade. Same
 * assembly-line pattern as the family chain: each finished clip queues the
 * next via the job-result hook; the last one queues a veoConcat video_edit.
 */
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { buildVideoBrief, estimateReelCostUsd } from '@/lib/content-engine/video-brief'
import { pickScene } from '@/lib/tryon/scene-pool'

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

export async function startVeoReelChain(input: {
  productImagePath: string
  totalClips: number
  aspect: '9:16' | '16:9'
  vibe?: VeoChainState['vibe']
}): Promise<{ pendingActionId: string; costUsd: number }> {
  const state: VeoChainState = {
    veoChain: true,
    chainId: randomUUID(),
    index: 0,
    totalClips: Math.min(3, Math.max(2, input.totalClips)),
    clipSec: VEO_CLIP_SEC,
    aspect: input.aspect,
    productImagePath: input.productImagePath,
    vibe: input.vibe ?? 'premium',
    clipPaths: [],
  }
  const row = await db.agentPendingAction.create({ data: clipAction(state) })
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
    const row = await db.agentPendingAction.create({ data: clipAction(next) })
    return row.id as string
  }

  // all clips done → one ffmpeg crossfade-concat job on the worker
  const row = await db.agentPendingAction.create({
    data: {
      conversationId: null,
      type: 'video_edit',
      payload: {
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
      },
      summary: `🎬 লম্বা রিল — ${p.totalClips} ক্লিপ জোড়া লাগছে`,
      costEstimate: 0,
      status: 'approved',
    },
  })
  return row.id as string
}
