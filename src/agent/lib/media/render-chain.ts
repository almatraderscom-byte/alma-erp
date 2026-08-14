/**
 * Media mode — render chain (M1+M2). Approve → per-scene audio → images →
 * clips → final concat, one stage at a time, every asset delivered to the
 * conversation as it lands (CapCut order: fail cheap-first).
 *
 * Mechanics mirror veo-chain: each stage enqueues already-approved pending
 * actions (the plan card was the ONLY money gate); the worker executes them and
 * `advanceMediaChain` (called from the job-result route on `payload.mediaChain`)
 * records the asset and starts the next stage when the current one drains.
 * State lives in agent_media_assets rows — no in-memory chain state, so a
 * Vercel restart or worker retry re-derives everything from the DB.
 */
import { prisma } from '@/lib/prisma'
import type { MediaPlan, MediaVideoModel } from './plan-schema'

 
const db = prisma as any

export type MediaChainStage = 'vo' | 'music' | 'image' | 'clip' | 'final'

export type MediaChainTag = {
  projectId: string
  assetId: string
  stage: MediaChainStage
  sceneId?: string | null
}

/** Actual spend may exceed the locked estimate by at most this factor. */
export const MEDIA_BUDGET_MULTIPLIER = 1.25

const VIDEO_PROVIDER: Record<MediaVideoModel, { provider: 'veo' | 'seedance'; endpoint?: string; resolution?: string }> = {
  'seedance-2.5-pro': { provider: 'seedance', endpoint: 'bytedance/seedance-2.5/image-to-video', resolution: '720p' },
  'seedance-2.5-lite': { provider: 'seedance', endpoint: 'bytedance/seedance-2.5/image-to-video', resolution: '480p' },
  'seedance-1.0-pro': { provider: 'seedance', endpoint: 'fal-ai/bytedance/seedance/v1/pro/image-to-video', resolution: '1080p' },
  'seedance-1.0-lite': { provider: 'seedance', endpoint: 'fal-ai/bytedance/seedance/v1/lite/image-to-video', resolution: '720p' },
  'veo-3.1-fast': { provider: 'veo' },
  'veo-3.1': { provider: 'veo' },
}

function imageQuality(model: MediaPlan['models']['image']): 'standard' | 'pro' {
  return model === 'gemini-3.1-flash-image' ? 'standard' : 'pro'
}

type ProjectRow = {
  id: string
  conversationId: string | null
  title: string
  status: string
  planJson: MediaPlan
  totalEstimateUsd: number | null
}

type SceneRow = {
  id: string
  idx: number
  brief: string
  voScript: string | null
  imagePrompt: string
  clipBrief: string | null
  durationSec: number
}

async function loadProject(projectId: string): Promise<{ project: ProjectRow; scenes: SceneRow[] } | null> {
  const project = await db.agentMediaProject.findUnique({ where: { id: projectId } })
  if (!project) return null
  const scenes = await db.agentMediaScene.findMany({
    where: { projectId },
    orderBy: { idx: 'asc' },
  })
  return { project, scenes }
}

/** Create one queued asset row + its already-approved worker action. */
async function enqueueAsset(args: {
  project: ProjectRow
  stage: MediaChainStage
  scene?: SceneRow | null
  actionType: 'audio_gen' | 'image_gen' | 'video_gen' | 'video_edit'
  modelId: string
  buildPayload: (tag: MediaChainTag) => Record<string, unknown>
  summary: string
}): Promise<string> {
  const asset = await db.agentMediaAsset.create({
    data: {
      projectId: args.project.id,
      sceneId: args.scene?.id ?? null,
      kind: args.stage,
      status: 'queued',
      modelId: args.modelId,
    },
  })
  const tag: MediaChainTag = {
    projectId: args.project.id,
    assetId: asset.id,
    stage: args.stage,
    sceneId: args.scene?.id ?? null,
  }
  const action = await db.agentPendingAction.create({
    data: {
      conversationId: args.project.conversationId,
      type: args.actionType,
      payload: { ...args.buildPayload(tag), mediaChain: tag, conversationId: args.project.conversationId },
      summary: args.summary,
      // Already paid for by the approved plan — runs without another card.
      status: 'approved',
    },
  })
  await db.agentMediaAsset.update({ where: { id: asset.id }, data: { jobId: action.id, status: 'rendering' } })
  return asset.id as string
}

function sceneLabel(project: ProjectRow, scene: SceneRow, what: string): string {
  return `🎬 ${project.title} — S${scene.idx} ${what}`
}

/** Stage 1: every scene's VO (+ the music bed) in parallel — cheapest first. */
async function enqueueAudioStage(project: ProjectRow, scenes: SceneRow[]): Promise<number> {
  const plan = project.planJson
  let queued = 0
  if (plan.audio.mode === 'vo' || plan.audio.mode === 'vo+music') {
    for (const scene of scenes) {
      if (!scene.voScript) continue
      const voice = plan.audio.voice ?? 'elevenlabs'
      await enqueueAsset({
        project,
        stage: 'vo',
        scene,
        actionType: 'audio_gen',
        modelId: `elevenlabs:${voice}`,
        summary: sceneLabel(project, scene, `ভয়েসওভার`),
        buildPayload: () => ({
          kind: voice === 'owner_clone' ? 'owner_voice' : 'media_vo',
          // owner_voice resolves the cloned voice id from kv (legacy path);
          // media_vo uses generic ElevenLabs voices only.
          ...(voice === 'owner_clone' ? { legacyOwnerVoice: true } : {}),
          text: scene.voScript,
          voice,
          skipTelegramCard: true,
        }),
      })
      queued++
    }
  }
  if (plan.audio.mode === 'music' || plan.audio.mode === 'vo+music') {
    const totalSec = scenes.reduce((acc, s) => acc + s.durationSec, 0)
    await enqueueAsset({
      project,
      stage: 'music',
      actionType: 'audio_gen',
      modelId: 'elevenlabs:music',
      summary: `🎬 ${project.title} — ব্যাকগ্রাউন্ড মিউজিক`,
      buildPayload: () => ({
        kind: 'music',
        prompt: plan.audio.musicBrief ?? `Calm cinematic background music for: ${project.title}`,
        seconds: Math.min(120, Math.max(10, Math.round(totalSec))),
        skipTelegramCard: true,
      }),
    })
    queued++
  }
  return queued
}

/** Stage 2: one keyframe image per scene. */
async function enqueueImageStage(project: ProjectRow, scenes: SceneRow[]): Promise<number> {
  const plan = project.planJson
  for (const scene of scenes) {
    await enqueueAsset({
      project,
      stage: 'image',
      scene,
      actionType: 'image_gen',
      modelId: plan.models.image,
      summary: sceneLabel(project, scene, `ছবি`),
      buildPayload: () => ({
        prompt: scene.imagePrompt,
        quality: imageQuality(plan.models.image),
        // worker: payload.imageModel pins BOTH quality lanes to this model
        imageModel: plan.models.image,
        aspectRatio: plan.aspect,
        variationCount: 1,
        skipTelegramCard: true,
      }),
    })
  }
  return scenes.length
}

/** Stage 3: image→video clip per scene. */
async function enqueueClipStage(project: ProjectRow, scenes: SceneRow[]): Promise<number> {
  const plan = project.planJson
  const video = VIDEO_PROVIDER[plan.models.video] ?? VIDEO_PROVIDER['veo-3.1-fast']
  const images = await db.agentMediaAsset.findMany({
    where: { projectId: project.id, kind: 'image', status: 'ready' },
    orderBy: { createdAt: 'asc' },
  })
  const imageByScene = new Map<string, { storagePath: string | null }>()
  for (const img of images) if (img.sceneId) imageByScene.set(img.sceneId, img)
  let queued = 0
  for (const scene of scenes) {
    const image = imageByScene.get(scene.id)
    if (!image?.storagePath) continue
    await enqueueAsset({
      project,
      stage: 'clip',
      scene,
      actionType: 'video_gen',
      modelId: plan.models.video,
      summary: sceneLabel(project, scene, `ক্লিপ`),
      buildPayload: () => ({
        prompt: scene.clipBrief || scene.brief,
        referenceImageId: image.storagePath,
        // Veo caps clips at 8s; Seedance handles up to 15s.
        durationSec: video.provider === 'veo' ? Math.min(8, scene.durationSec) : scene.durationSec,
        aspect: plan.aspect === '1:1' ? '9:16' : plan.aspect,
        provider: video.provider,
        falEndpoint: video.endpoint,
        falResolution: video.resolution,
        skipTelegramCard: true,
      }),
    })
    queued++
  }
  return queued
}

/** Stage 4: concat clips + mix VO/music into the final video. */
async function enqueueFinalStage(project: ProjectRow, scenes: SceneRow[]): Promise<number> {
  const plan = project.planJson
  const assets = await db.agentMediaAsset.findMany({
    where: { projectId: project.id, status: 'ready' },
    orderBy: { createdAt: 'asc' },
  })
  const byScene = (kind: string) => {
    const m = new Map<string, string>()
    for (const a of assets) if (a.kind === kind && a.sceneId && a.storagePath) m.set(a.sceneId, a.storagePath)
    return m
  }
  const clips = byScene('clip')
  const vos = byScene('vo')
  const music = assets.find((a: { kind: string; storagePath?: string | null }) => a.kind === 'music')?.storagePath ?? null
  const ordered = scenes
    .map((s) => ({
      sceneIdx: s.idx,
      durationSec: s.durationSec,
      clipPath: clips.get(s.id) ?? null,
      voPath: vos.get(s.id) ?? null,
    }))
    .filter((s) => Boolean(s.clipPath))
  if (ordered.length === 0) return 0
  await enqueueAsset({
    project,
    stage: 'final',
    actionType: 'video_edit',
    modelId: 'ffmpeg:mediaConcat',
    summary: `🎬 ${project.title} — ফাইনাল ভিডিও (স্টিচ + অডিও মিক্স)`,
    buildPayload: () => ({
      mediaConcat: {
        scenes: ordered,
        musicPath: music,
        aspect: plan.aspect,
        title: project.title,
      },
      skipTelegramCard: true,
    }),
  })
  return 1
}

/**
 * Kick off rendering for an approved project. Idempotent: refuses when the
 * project is not 'approved' (already rendering/final) so an approve-route retry
 * can't double-render.
 */
export async function startMediaRender(projectId: string): Promise<{ started: boolean; queued: number }> {
  const claimed = await db.agentMediaProject.updateMany({
    where: { id: projectId, status: 'approved' },
    data: { status: 'rendering' },
  })
  if (claimed.count === 0) return { started: false, queued: 0 }
  const loaded = await loadProject(projectId)
  if (!loaded) return { started: false, queued: 0 }
  const { project, scenes } = loaded
  let queued = await enqueueAudioStage(project, scenes)
  if (queued === 0) queued = await enqueueImageStage(project, scenes) // silent plan: straight to images
  return { started: true, queued }
}

type JobResultData = { storagePath?: unknown; costUsd?: unknown; durationSec?: unknown } | null | undefined

/**
 * Advance the chain after a worker job settles. Returns a short note for logs.
 * Called with the action row + parsed result data from the job-result route.
 */
export async function advanceMediaChain(
  action: { id: string; payload: unknown },
  status: 'success' | 'failed',
  data: JobResultData,
): Promise<string> {
  const tag = (action.payload as { mediaChain?: MediaChainTag }).mediaChain
  if (!tag?.projectId || !tag.assetId) return 'no-tag'

  const storagePath = typeof data?.storagePath === 'string' ? data.storagePath : null
  const costUsd = typeof data?.costUsd === 'number' ? data.costUsd : null
  await db.agentMediaAsset.updateMany({
    where: { id: tag.assetId },
    data: {
      status: status === 'success' && storagePath ? 'ready' : 'failed',
      storagePath,
      costUsd,
    },
  })

  const loaded = await loadProject(tag.projectId)
  if (!loaded) return 'project-missing'
  const { project, scenes } = loaded
  if (project.status !== 'rendering') return `project-${project.status}`

  const assets = await db.agentMediaAsset.findMany({ where: { projectId: tag.projectId } })
  const pendingOf = (kinds: MediaChainStage[]) =>
    assets.filter(
      (a: { kind: MediaChainStage; status: string }) =>
        kinds.includes(a.kind) && (a.status === 'queued' || a.status === 'rendering'),
    ).length
  const anyOf = (kind: MediaChainStage) => assets.some((a: { kind: string }) => a.kind === kind)
  const failedOf = (kinds: MediaChainStage[]) =>
    assets.filter((a: { kind: MediaChainStage; status: string }) => kinds.includes(a.kind) && a.status === 'failed').length

  // Budget guard: actual spend beyond estimate × multiplier aborts the chain.
  const spent = assets.reduce(
    (acc: number, a: { costUsd: number | null }) => acc + (typeof a.costUsd === 'number' ? a.costUsd : 0),
    0,
  )
  const budget = (project.totalEstimateUsd ?? 0) * MEDIA_BUDGET_MULTIPLIER
  if (budget > 0 && spent > budget) {
    await db.agentMediaProject.updateMany({
      where: { id: tag.projectId, status: 'rendering' },
      data: { status: 'failed' },
    })
    return `budget-exceeded ($${spent.toFixed(2)} > $${budget.toFixed(2)})`
  }

  // FINAL stage settled → project done (or failed).
  if (tag.stage === 'final') {
    await db.agentMediaProject.updateMany({
      where: { id: tag.projectId, status: 'rendering' },
      data:
        status === 'success' && storagePath
          ? { status: 'final', finalAssetPath: storagePath, totalActualUsd: spent }
          : { status: 'failed', totalActualUsd: spent },
    })
    return status === 'success' ? 'final-delivered' : 'final-failed'
  }

  // A whole stage failing (every scene failed) kills the run honestly.
  if (pendingOf(['vo', 'music']) === 0 && anyOf('vo') && failedOf(['vo']) === assets.filter((a: { kind: string }) => a.kind === 'vo').length && failedOf(['vo']) > 0) {
    await db.agentMediaProject.updateMany({ where: { id: tag.projectId, status: 'rendering' }, data: { status: 'failed' } })
    return 'audio-stage-failed'
  }

  // Stage transitions — only when the current stage fully drains.
  if ((tag.stage === 'vo' || tag.stage === 'music') && pendingOf(['vo', 'music']) === 0) {
    if (!anyOf('image')) {
      const queued = await enqueueImageStage(project, scenes)
      return `images-queued(${queued})`
    }
    return 'audio-drained'
  }
  if (tag.stage === 'image' && pendingOf(['image']) === 0) {
    if (!anyOf('clip')) {
      const readyImages = assets.filter((a: { kind: string; status: string }) => a.kind === 'image' && a.status === 'ready').length
      if (readyImages === 0) {
        await db.agentMediaProject.updateMany({ where: { id: tag.projectId, status: 'rendering' }, data: { status: 'failed' } })
        return 'image-stage-failed'
      }
      const queued = await enqueueClipStage(project, scenes)
      return `clips-queued(${queued})`
    }
    return 'images-drained'
  }
  if (tag.stage === 'clip' && pendingOf(['clip']) === 0) {
    if (!anyOf('final')) {
      const queued = await enqueueFinalStage(project, scenes)
      if (queued === 0) {
        await db.agentMediaProject.updateMany({ where: { id: tag.projectId, status: 'rendering' }, data: { status: 'failed' } })
        return 'clip-stage-failed'
      }
      return 'final-queued'
    }
    return 'clips-drained'
  }
  return 'stage-progress'
}
