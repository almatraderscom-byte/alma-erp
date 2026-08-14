/**
 * Media mode — MediaPlan contract (docs/MEDIA_MODE_ROADMAP.md §4).
 *
 * The head (planner LLM) emits this shape via the plan_media_video tool. The
 * server NORMALIZES it (clamps durations, drops invalid scenes) and RECOMPUTES
 * the cost estimate itself (media/cost.ts) — LLM arithmetic is never trusted.
 */

export const MEDIA_PLAN_VERSION = 1

export const MEDIA_IMAGE_MODELS = ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'seedream-5.0-pro'] as const
export type MediaImageModel = (typeof MEDIA_IMAGE_MODELS)[number]

export const MEDIA_VIDEO_MODELS = ['seedance-1.0-pro', 'seedance-1.0-lite', 'veo-3.1-fast', 'veo-3.1'] as const
export type MediaVideoModel = (typeof MEDIA_VIDEO_MODELS)[number]

export type MediaAudioMode = 'vo' | 'music' | 'vo+music' | 'none'

export type MediaScenePlan = {
  idx: number
  durationSec: number
  brief: string
  voScript: string | null
  imagePrompt: string
  clipBrief: string
  usesOwnerPhoto: boolean
}

export type MediaPlanEstimateLine = { label: string; usd: number }

export type MediaPlanEstimate = {
  lines: MediaPlanEstimateLine[]
  totalUsd: number
  totalBdt: number
}

export type MediaPlan = {
  version: number
  title: string
  aspect: '9:16' | '16:9' | '1:1'
  language: string
  durationSec: number
  audio: {
    mode: MediaAudioMode
    /** 'owner_clone' | 'elevenlabs:<voiceId>' | 'google' */
    voice: string | null
    musicBrief: string | null
  }
  models: { image: MediaImageModel; video: MediaVideoModel }
  personalization: { useOwnerPhotos: boolean; photoPaths: string[] }
  scenes: MediaScenePlan[]
  captions: boolean
  /** Server-computed — anything the LLM sent here is discarded. */
  estimate?: MediaPlanEstimate
}

export const MEDIA_SCENE_MIN_SEC = 3
export const MEDIA_SCENE_MAX_SEC = 10
export const MEDIA_MAX_SCENES = 20

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback
}

/**
 * Normalize an untrusted (LLM-produced) plan object. Throws with a Bangla-safe
 * message when the plan is unusable; silently clamps recoverable issues.
 */
export function normalizeMediaPlan(raw: unknown): MediaPlan {
  if (!raw || typeof raw !== 'object') throw new Error('media plan missing or not an object')
  const p = raw as Record<string, unknown>

  const title = str(p.title)
  if (!title) throw new Error('media plan needs a title')

  const aspect = p.aspect === '16:9' || p.aspect === '1:1' ? p.aspect : '9:16'
  const language = str(p.language, 'bn') || 'bn'

  const rawScenes = Array.isArray(p.scenes) ? p.scenes : []
  const scenes: MediaScenePlan[] = rawScenes
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .slice(0, MEDIA_MAX_SCENES)
    .map((s, i) => ({
      idx: i + 1,
      durationSec: Math.min(MEDIA_SCENE_MAX_SEC, Math.max(MEDIA_SCENE_MIN_SEC, Number(s.durationSec) || 6)),
      brief: str(s.brief),
      voScript: str(s.voScript) || null,
      imagePrompt: str(s.imagePrompt),
      clipBrief: str(s.clipBrief) || str(s.brief),
      usesOwnerPhoto: Boolean(s.usesOwnerPhoto),
    }))
    .filter((s) => s.brief.length > 0 && s.imagePrompt.length > 0)
  if (scenes.length === 0) throw new Error('media plan needs at least one scene with brief + imagePrompt')

  const audioRaw = (p.audio && typeof p.audio === 'object' ? p.audio : {}) as Record<string, unknown>
  const mode: MediaAudioMode =
    audioRaw.mode === 'music' || audioRaw.mode === 'vo+music' || audioRaw.mode === 'none'
      ? audioRaw.mode
      : 'vo'

  const modelsRaw = (p.models && typeof p.models === 'object' ? p.models : {}) as Record<string, unknown>
  const image = MEDIA_IMAGE_MODELS.includes(modelsRaw.image as MediaImageModel)
    ? (modelsRaw.image as MediaImageModel)
    : 'gemini-3-pro-image'
  const video = MEDIA_VIDEO_MODELS.includes(modelsRaw.video as MediaVideoModel)
    ? (modelsRaw.video as MediaVideoModel)
    : 'seedance-1.0-pro'

  const persRaw = (p.personalization && typeof p.personalization === 'object' ? p.personalization : {}) as Record<string, unknown>
  const photoPaths = Array.isArray(persRaw.photoPaths)
    ? persRaw.photoPaths.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 10)
    : []

  return {
    version: MEDIA_PLAN_VERSION,
    title,
    aspect,
    language,
    durationSec: scenes.reduce((acc, s) => acc + s.durationSec, 0),
    audio: {
      mode,
      voice: str(audioRaw.voice) || (mode === 'vo' || mode === 'vo+music' ? 'owner_clone' : null),
      musicBrief: str(audioRaw.musicBrief) || null,
    },
    models: { image, video },
    personalization: { useOwnerPhotos: Boolean(persRaw.useOwnerPhotos) || photoPaths.length > 0, photoPaths },
    scenes,
    captions: p.captions === undefined ? true : Boolean(p.captions),
  }
}
