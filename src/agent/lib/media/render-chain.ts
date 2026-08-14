/**
 * Media mode — render chain (M1+M2). Approve → per-scene audio → images →
 * clips → final concat, one stage at a time, every asset delivered to the
 * conversation as it lands (CapCut order: fail cheap-first).
 *
 * Concurrency model: the project row carries a per-stage status
 * (rendering_audio → rendering_image → rendering_clip → rendering_final) and
 * every stage transition is a compare-and-set on that status INSIDE the same
 * transaction that inserts the next stage's assets+jobs. Two parallel
 * job-result callbacks can both see a drained stage, but only one wins the CAS
 * — the loser's transaction rolls back having enqueued nothing. A crash
 * mid-transaction rolls back the claim too, so the worker's retried callback
 * (job-result returns 503 on advance failure) re-runs the transition cleanly.
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

/** Per-stage project statuses — the CAS tokens for stage transitions. */
export const MEDIA_RENDERING_STATUSES = [
  'rendering_audio',
  'rendering_image',
  'rendering_clip',
  'rendering_final',
] as const
export type MediaRenderingStatus = (typeof MEDIA_RENDERING_STATUSES)[number]

export function isMediaRendering(status: string | null | undefined): boolean {
  return MEDIA_RENDERING_STATUSES.includes(status as MediaRenderingStatus)
}

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

// Loose transaction-client type — the generated prisma client type is not
// available here (same seam as video-tools/media-tools).
 
type Tx = any

async function loadProject(client: Tx, projectId: string): Promise<{ project: ProjectRow; scenes: SceneRow[] } | null> {
  const project = await client.agentMediaProject.findUnique({ where: { id: projectId } })
  if (!project) return null
  const scenes = await client.agentMediaScene.findMany({
    where: { projectId },
    orderBy: { idx: 'asc' },
  })
  return { project, scenes }
}

/** Create one asset row + its already-approved worker action (inside tx). */
async function enqueueAsset(tx: Tx, args: {
  project: ProjectRow
  stage: MediaChainStage
  scene?: SceneRow | null
  actionType: 'audio_gen' | 'image_gen' | 'video_gen' | 'video_edit'
  modelId: string
  buildPayload: (tag: MediaChainTag) => Record<string, unknown>
  summary: string
  version?: number
}): Promise<string> {
  const asset = await tx.agentMediaAsset.create({
    data: {
      projectId: args.project.id,
      sceneId: args.scene?.id ?? null,
      kind: args.stage,
      status: 'rendering',
      modelId: args.modelId,
      ...(args.version ? { version: args.version } : {}),
    },
  })
  const tag: MediaChainTag = {
    projectId: args.project.id,
    assetId: asset.id,
    stage: args.stage,
    sceneId: args.scene?.id ?? null,
  }
  const action = await tx.agentPendingAction.create({
    data: {
      conversationId: args.project.conversationId,
      type: args.actionType,
      payload: { ...args.buildPayload(tag), mediaChain: tag, conversationId: args.project.conversationId },
      summary: args.summary,
      // Already paid for by the approved plan — runs without another card.
      status: 'approved',
    },
  })
  await tx.agentMediaAsset.update({ where: { id: asset.id }, data: { jobId: action.id } })
  return asset.id as string
}

function sceneLabel(project: ProjectRow, scene: SceneRow, what: string): string {
  return `🎬 ${project.title} — S${scene.idx} ${what}`
}

/** Owner-photo references for a scene, when the plan asked for them. */
function ownerPhotoRefs(plan: MediaPlan, sceneIdx: number): Record<string, unknown> {
  const planScene = plan.scenes.find((s) => s.idx === sceneIdx)
  const photos = plan.personalization.photoPaths
  if (!planScene?.usesOwnerPhoto || photos.length === 0) return {}
  return {
    referenceImageId: photos[0],
    ...(photos.length > 1 ? { referenceImageIds: photos.slice(0, 3) } : {}),
  }
}

/** Stage 1: every scene's VO (+ the music bed) in parallel — cheapest first. */
async function enqueueAudioStage(tx: Tx, project: ProjectRow, scenes: SceneRow[]): Promise<number> {
  const plan = project.planJson
  let queued = 0
  if (plan.audio.mode === 'vo' || plan.audio.mode === 'vo+music') {
    for (const scene of scenes) {
      if (!scene.voScript) continue
      const voice = plan.audio.voice ?? 'elevenlabs'
      await enqueueAsset(tx, {
        project,
        stage: 'vo',
        scene,
        actionType: 'audio_gen',
        modelId: voice.startsWith('google') ? 'google_tts' : `elevenlabs:${voice}`,
        summary: sceneLabel(project, scene, `ভয়েসওভার`),
        buildPayload: () => ({
          kind: voice === 'owner_clone' ? 'owner_voice' : 'media_vo',
          // owner_voice resolves the cloned voice id from kv (legacy path);
          // media_vo handles generic ElevenLabs voices AND Google TTS.
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
    await enqueueAsset(tx, {
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
async function enqueueImageStage(tx: Tx, project: ProjectRow, scenes: SceneRow[]): Promise<number> {
  const plan = project.planJson
  for (const scene of scenes) {
    await enqueueAsset(tx, {
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
        // Plan promised the owner's face in this scene → bind his photo(s)
        // as generation references, not just the text prompt.
        ...ownerPhotoRefs(plan, scene.idx),
        skipTelegramCard: true,
      }),
    })
  }
  return scenes.length
}

/** Stage 3: image→video clip per scene (reads ready images inside the tx). */
async function enqueueClipStage(tx: Tx, project: ProjectRow, scenes: SceneRow[]): Promise<number> {
  const plan = project.planJson
  const video = VIDEO_PROVIDER[plan.models.video] ?? VIDEO_PROVIDER['veo-3.1-fast']
  const images = await tx.agentMediaAsset.findMany({
    where: { projectId: project.id, kind: 'image', status: 'ready' },
    orderBy: { createdAt: 'asc' },
  })
  const imageByScene = new Map<string, { storagePath: string | null }>()
  for (const img of images) if (img.sceneId) imageByScene.set(img.sceneId, img)
  let queued = 0
  for (const scene of scenes) {
    const image = imageByScene.get(scene.id)
    if (!image?.storagePath) continue
    await enqueueClipForScene(tx, project, scene, image.storagePath, { note: null, version: undefined })
    queued++
  }
  return queued
}

/** One image→video clip job for one scene (initial render AND regen paths). */
async function enqueueClipForScene(
  tx: Tx,
  project: ProjectRow,
  scene: SceneRow,
  imagePath: string,
  opts: { note: string | null; version?: number },
): Promise<string> {
  const plan = project.planJson
  const video = VIDEO_PROVIDER[plan.models.video] ?? VIDEO_PROVIDER['veo-3.1-fast']
  const basePrompt = scene.clipBrief || scene.brief
  return await enqueueAsset(tx, {
    project,
    stage: 'clip',
    scene,
    actionType: 'video_gen',
    modelId: plan.models.video,
    summary: sceneLabel(project, scene, opts.version ? `ক্লিপ v${opts.version}` : `ক্লিপ`),
    version: opts.version,
    buildPayload: () => ({
      prompt: opts.note ? `${basePrompt}\n\nOwner revision note: ${opts.note}` : basePrompt,
      referenceImageId: imagePath,
      // Veo caps clips at 8s; Seedance handles up to 15s.
      durationSec: video.provider === 'veo' ? Math.min(8, scene.durationSec) : scene.durationSec,
      aspect: plan.aspect,
      provider: video.provider,
      falEndpoint: video.endpoint,
      falResolution: video.resolution,
      skipTelegramCard: true,
    }),
  })
}

/** Stage 4: concat clips + mix VO/music into the final video. */
async function enqueueFinalStage(tx: Tx, project: ProjectRow, scenes: SceneRow[]): Promise<number> {
  const plan = project.planJson
  const assets = await tx.agentMediaAsset.findMany({
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
  await enqueueAsset(tx, {
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
 * Kick off rendering for an approved project. The status CAS + first-stage
 * enqueue share one transaction, so an approve-route retry can't double-start
 * and a crash can't leave a claimed-but-empty stage.
 */
export async function startMediaRender(projectId: string): Promise<{ started: boolean; queued: number }> {
  const loaded = await loadProject(db, projectId)
  if (!loaded) return { started: false, queued: 0 }
  const { project, scenes } = loaded
  const plan = project.planJson
  const hasAudio = plan.audio.mode !== 'none'
  const firstStatus: MediaRenderingStatus = hasAudio ? 'rendering_audio' : 'rendering_image'
  return await db.$transaction(async (tx: Tx) => {
    const claimed = await tx.agentMediaProject.updateMany({
      where: { id: projectId, status: 'approved' },
      data: { status: firstStatus },
    })
    if (claimed.count === 0) return { started: false, queued: 0 }
    const projectRunning = { ...project, status: firstStatus }
    const queued = hasAudio
      ? await enqueueAudioStage(tx, projectRunning, scenes)
      : await enqueueImageStage(tx, projectRunning, scenes)
    return { started: true, queued }
  })
}

type JobResultData = { storagePath?: unknown; costUsd?: unknown; durationSec?: unknown } | null | undefined

async function failProject(projectId: string, spent?: number): Promise<void> {
  await db.agentMediaProject.updateMany({
    where: { id: projectId, status: { in: [...MEDIA_RENDERING_STATUSES] } },
    data: { status: 'failed', ...(spent === undefined ? {} : { totalActualUsd: spent }) },
  })
}

/**
 * Advance the chain after a worker job settles. Returns a short note for logs.
 * Idempotent under job-result retries: the asset update is a plain overwrite
 * and every stage transition is CAS-guarded inside its transaction.
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

  const loaded = await loadProject(db, tag.projectId)
  if (!loaded) return 'project-missing'
  const { project, scenes } = loaded
  if (!isMediaRendering(project.status)) return `project-${project.status}`

  const assets = await db.agentMediaAsset.findMany({ where: { projectId: tag.projectId } })
  const ofKind = (kinds: MediaChainStage[]) => assets.filter((a: { kind: MediaChainStage }) => kinds.includes(a.kind))
  const pendingOf = (kinds: MediaChainStage[]) =>
    ofKind(kinds).filter((a: { status: string }) => a.status === 'queued' || a.status === 'rendering').length
  const readyOf = (kinds: MediaChainStage[]) =>
    ofKind(kinds).filter((a: { status: string }) => a.status === 'ready').length

  // Budget guard: actual spend beyond estimate × multiplier aborts the chain.
  const spent = assets.reduce(
    (acc: number, a: { costUsd: number | null }) => acc + (typeof a.costUsd === 'number' ? a.costUsd : 0),
    0,
  )
  const budget = (project.totalEstimateUsd ?? 0) * MEDIA_BUDGET_MULTIPLIER
  const settledAsset = assets.find((a: { id: string }) => a.id === tag.assetId)
  // Once ANY v2+ asset exists the project is in owner-directed regen territory:
  // each regen was an explicit ask, and the follow-up rebuild jobs (clip/final)
  // it triggers are part of that consent — the original plan's budget cap only
  // polices the automatic first render.
  const isRegenProject = assets.some((a: { version: number | null }) => (a.version ?? 1) > 1)
  if (!isRegenProject && budget > 0 && spent > budget) {
    await failProject(tag.projectId, spent)
    return `budget-exceeded ($${spent.toFixed(2)} > $${budget.toFixed(2)})`
  }

  // A regen replacement only supersedes the previous version once IT is ready —
  // a failed regen leaves the last good asset in place, so a rebuilt final can
  // never silently drop a scene or its narration.
  if (status === 'success' && storagePath && (settledAsset?.version ?? 1) > 1 && tag.sceneId) {
    await db.agentMediaAsset.updateMany({
      where: {
        projectId: tag.projectId,
        sceneId: tag.sceneId,
        kind: tag.stage,
        status: 'ready',
        version: { lt: settledAsset.version },
      },
      data: { status: 'superseded' },
    })
  }

  // FINAL stage settled → project done (or failed).
  if (tag.stage === 'final') {
    await db.agentMediaProject.updateMany({
      where: { id: tag.projectId, status: 'rendering_final' },
      data:
        status === 'success' && storagePath
          ? { status: 'final', finalAssetPath: storagePath, totalActualUsd: spent }
          : { status: 'failed', totalActualUsd: spent },
    })
    return status === 'success' ? 'final-delivered' : 'final-failed'
  }

  // Stage transitions — CAS + next-stage enqueue in ONE transaction. Only the
  // callback that wins the CAS enqueues; ties and retries are safe. Targets are
  // EXISTENCE-AWARE: on the first pass the next stage is empty and gets its
  // jobs; after a regenerate (later stages already populated) the chain jumps
  // straight to the final rebuild instead of re-buying downstream stages.
  const anyOf = (kind: MediaChainStage) => ofKind([kind]).length > 0
  if ((tag.stage === 'vo' || tag.stage === 'music') && pendingOf(['vo', 'music']) === 0) {
    const voCount = ofKind(['vo']).length
    if (voCount > 0 && readyOf(['vo']) === 0) {
      await failProject(tag.projectId)
      return 'audio-stage-failed'
    }
    const goFinal = anyOf('clip') // regen path: clips already exist → just re-stitch
    const queued = await db.$transaction(async (tx: Tx) => {
      const claimed = await tx.agentMediaProject.updateMany({
        where: { id: tag.projectId, status: 'rendering_audio' },
        data: { status: goFinal ? 'rendering_final' : 'rendering_image' },
      })
      if (claimed.count === 0) return -1
      return goFinal
        ? await enqueueFinalStage(tx, project, scenes)
        : await enqueueImageStage(tx, project, scenes)
    })
    return queued === -1 ? 'audio-transition-lost' : goFinal ? 'final-requeued' : `images-queued(${queued})`
  }
  if (tag.stage === 'image' && pendingOf(['image']) === 0) {
    if (readyOf(['image']) === 0) {
      await failProject(tag.projectId)
      return 'image-stage-failed'
    }
    // Regen path (clips already exist): a REPLACED image is invisible unless
    // its scene's clip is rebuilt from it — queue that one clip (v+1). A failed
    // image regen (old image still current) goes straight to a no-op re-stitch.
    const clipsExist = anyOf('clip')
    const regenSceneId =
      clipsExist && status === 'success' && (settledAsset?.version ?? 1) > 1 ? tag.sceneId ?? null : null
    const mode: 'clips' | 'regen-clip' | 'final' = !clipsExist ? 'clips' : regenSceneId ? 'regen-clip' : 'final'
    const queued = await db.$transaction(async (tx: Tx) => {
      const claimed = await tx.agentMediaProject.updateMany({
        where: { id: tag.projectId, status: 'rendering_image' },
        data: { status: mode === 'final' ? 'rendering_final' : 'rendering_clip' },
      })
      if (claimed.count === 0) return -1
      if (mode === 'clips') return await enqueueClipStage(tx, project, scenes)
      if (mode === 'regen-clip') {
        const scene = scenes.find((s) => s.id === regenSceneId)
        const newImage = await tx.agentMediaAsset.findFirst({
          where: { projectId: tag.projectId, sceneId: regenSceneId, kind: 'image', status: 'ready' },
          orderBy: { version: 'desc' },
        })
        if (!scene || !newImage?.storagePath) return 0
        const priorClip = await tx.agentMediaAsset.findFirst({
          where: { projectId: tag.projectId, sceneId: regenSceneId, kind: 'clip' },
          orderBy: { version: 'desc' },
        })
        await enqueueClipForScene(tx, project, scene, newImage.storagePath, {
          note: null,
          version: (priorClip?.version ?? 1) + 1,
        })
        return 1
      }
      return await enqueueFinalStage(tx, project, scenes)
    })
    if (queued === 0) {
      await failProject(tag.projectId)
      return `${mode}-stage-empty`
    }
    return queued === -1 ? 'image-transition-lost' : mode === 'final' ? 'final-requeued' : mode === 'regen-clip' ? 'regen-clip-queued' : `clips-queued(${queued})`
  }
  if (tag.stage === 'clip' && pendingOf(['clip']) === 0) {
    if (readyOf(['clip']) === 0) {
      await failProject(tag.projectId)
      return 'clip-stage-failed'
    }
    const queued = await db.$transaction(async (tx: Tx) => {
      const claimed = await tx.agentMediaProject.updateMany({
        where: { id: tag.projectId, status: 'rendering_clip' },
        data: { status: 'rendering_final' },
      })
      if (claimed.count === 0) return -1
      return await enqueueFinalStage(tx, project, scenes)
    })
    if (queued === 0) {
      await failProject(tag.projectId)
      return 'final-stage-empty'
    }
    return queued === -1 ? 'clip-transition-lost' : 'final-queued'
  }
  return 'stage-progress'
}

const REGEN_KINDS = ['vo', 'image', 'clip'] as const
export type MediaRegenKind = (typeof REGEN_KINDS)[number]

const REGEN_ENTRY_STATUS: Record<MediaRegenKind, MediaRenderingStatus> = {
  vo: 'rendering_audio',
  image: 'rendering_image',
  clip: 'rendering_clip',
}

/**
 * Regenerate ONE scene asset of a finished (or failed) project — the CapCut
 * per-asset 🔁. Supersedes the current version, enqueues v(n+1) with the
 * owner's tweak folded into the prompt, and re-enters the stage machine at
 * that asset's stage; the existence-aware transitions then rebuild only the
 * final stitch, never re-buying untouched scenes.
 */
export async function regenerateMediaAsset(args: {
  projectId: string
  sceneIdx: number
  kind: MediaRegenKind
  note?: string | null
}): Promise<{ success: boolean; error?: string; assetId?: string; version?: number }> {
  if (!REGEN_KINDS.includes(args.kind)) return { success: false, error: `kind must be one of ${REGEN_KINDS.join('/')}` }
  const loaded = await loadProject(db, args.projectId)
  if (!loaded) return { success: false, error: 'project not found' }
  const { project, scenes } = loaded
  // Only COMPLETED projects are regen-able: from 'failed', a lone replacement
  // clip would drain its stage and stitch a final containing only that scene.
  // Failed runs need a full resume (not built) — refuse with a clear reason.
  if (project.status !== 'final') {
    return {
      success: false,
      error:
        project.status === 'failed'
          ? 'প্রজেক্টটা অসম্পূর্ণ (failed) — এক দৃশ্য regenerate করলে শুধু সেই দৃশ্যের ভিডিও তৈরি হয়ে যেত; নতুন প্ল্যান বানিয়ে আবার চালান।'
          : `project is ${project.status} — রেন্ডার চলা অবস্থায় regenerate করা যায় না`,
    }
  }
  const scene = scenes.find((s) => s.idx === args.sceneIdx)
  if (!scene) return { success: false, error: `S${args.sceneIdx} নেই — দৃশ্য 1..${scenes.length}` }
  const plan = project.planJson
  if (args.kind === 'vo' && !scene.voScript) return { success: false, error: `S${args.sceneIdx} এর কোনো ভয়েসওভার নেই` }
  if (args.kind === 'vo' && (args.note ?? '').trim()) {
    // A VO note can't reach the model: the spoken text IS the script, and
    // delivery/emotion tuning isn't wired yet. Refuse instead of billing a
    // regeneration that ignores the owner's wish.
    return {
      success: false,
      error:
        'ভয়েস ডেলিভারি টিউনিং এখনো নেই — নোট ছাড়া regenerate করলে নতুন টেক হবে; স্ক্রিপ্ট বদলাতে চাইলে plan_media_video দিয়ে প্ল্যান রিভাইজ করুন।',
    }
  }

  const entry = REGEN_ENTRY_STATUS[args.kind]
  const note = (args.note ?? '').trim()
  try {
    return await db.$transaction(async (tx: Tx) => {
      const claimed = await tx.agentMediaProject.updateMany({
        where: { id: args.projectId, status: 'final' },
        data: { status: entry },
      })
      if (claimed.count === 0) return { success: false, error: 'project busy — আরেকটা regenerate চলছে' }
      const prior = await tx.agentMediaAsset.findMany({
        where: { projectId: args.projectId, sceneId: scene.id, kind: args.kind },
        orderBy: { version: 'desc' },
      })
      const version = (prior[0]?.version ?? 0) + 1
      // The previous version stays 'ready' until the replacement succeeds —
      // supersession happens in advanceMediaChain on the v(n+1) success.
      const projectRunning = { ...project, status: entry }
      let assetId: string
      if (args.kind === 'vo') {
        const voice = plan.audio.voice ?? 'elevenlabs'
        assetId = await enqueueAsset(tx, {
          project: projectRunning,
          stage: 'vo',
          scene,
          actionType: 'audio_gen',
          modelId: voice.startsWith('google') ? 'google_tts' : `elevenlabs:${voice}`,
          summary: sceneLabel(projectRunning, scene, `ভয়েসওভার v${version}`),
          version,
          buildPayload: () => ({
            kind: voice === 'owner_clone' ? 'owner_voice' : 'media_vo',
            ...(voice === 'owner_clone' ? { legacyOwnerVoice: true } : {}),
            text: scene.voScript,
            voice,
            skipTelegramCard: true,
          }),
        })
      } else if (args.kind === 'image') {
        assetId = await enqueueAsset(tx, {
          project: projectRunning,
          stage: 'image',
          scene,
          actionType: 'image_gen',
          modelId: plan.models.image,
          summary: sceneLabel(projectRunning, scene, `ছবি v${version}`),
          version,
          buildPayload: () => ({
            prompt: note ? `${scene.imagePrompt}\n\nOwner revision note: ${note}` : scene.imagePrompt,
            quality: imageQuality(plan.models.image),
            imageModel: plan.models.image,
            aspectRatio: plan.aspect,
            variationCount: 1,
            ...ownerPhotoRefs(plan, scene.idx),
            skipTelegramCard: true,
          }),
        })
      } else {
        const image =
          (await tx.agentMediaAsset.findFirst({
            where: { projectId: args.projectId, sceneId: scene.id, kind: 'image', status: 'ready' },
            orderBy: { version: 'desc' },
          })) ??
          (await tx.agentMediaAsset.findFirst({
            where: { projectId: args.projectId, sceneId: scene.id, kind: 'image', status: 'superseded' },
            orderBy: { version: 'desc' },
          }))
        if (!image?.storagePath) {
          throw new Error(`S${args.sceneIdx} এর কোনো ছবি নেই — আগে ছবিটা regenerate করুন`)
        }
        assetId = await enqueueClipForScene(tx, projectRunning, scene, image.storagePath, {
          note: note || null,
          version,
        })
      }
      return { success: true, assetId, version }
    })
  } catch (err) {
    // Transaction rolled back (project back to final/failed is NOT automatic —
    // the CAS write also rolled back, so the status is untouched).
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
