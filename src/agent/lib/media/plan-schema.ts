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

export const MEDIA_VIDEO_MODELS = [
  'seedance-2.5-pro', // fal bytedance/seedance-2.5 image-to-video 720p — best quality, priciest
  'seedance-2.5-lite', // same endpoint at 480p
  'seedance-1.0-pro',
  'seedance-1.0-lite',
  'veo-3.1-fast',
  'veo-3.1',
] as const
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
  aspect: '9:16' | '16:9'
  language: string
  durationSec: number
  audio: {
    mode: MediaAudioMode
    /** 'elevenlabs' (default profile) | 'elevenlabs:<voiceId>' | 'owner_clone' | 'google' */
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

  // '1:1' rejected: neither Veo nor Seedance renders square natively and the
  // concat worker does not crop — a square card would promise what we can't ship.
  const aspect = p.aspect === '16:9' ? '16:9' : '9:16'
  const language = str(p.language, 'bn') || 'bn'

  const rawScenes = Array.isArray(p.scenes) ? p.scenes : []
  // Filter invalid entries BEFORE assigning idx — S-numbers must stay contiguous
  // (S1..Sn) because they are persisted and the owner addresses scenes by them.
  const scenes: MediaScenePlan[] = rawScenes
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .filter((s) => str(s.brief).length > 0 && str(s.imagePrompt).length > 0)
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
  if (scenes.length === 0) throw new Error('media plan needs at least one scene with brief + imagePrompt')

  const audioRaw = (p.audio && typeof p.audio === 'object' ? p.audio : {}) as Record<string, unknown>
  const mode: MediaAudioMode =
    audioRaw.mode === 'music' || audioRaw.mode === 'vo+music' || audioRaw.mode === 'none'
      ? audioRaw.mode
      : 'vo'

  // VO mode with narration-less scenes would quote ৳0 voiceover while the card
  // still advertises VO — reject so the planner retries with complete scripts.
  if (mode === 'vo' || mode === 'vo+music') {
    const missing = scenes.filter((s) => !s.voScript).map((s) => `S${s.idx}`)
    if (missing.length > 0) {
      throw new Error(`audio mode "${mode}" needs a voScript for every scene — missing: ${missing.join(', ')}`)
    }
  }

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
      // Default = generic ElevenLabs voice (any of its voices/styles work);
      // the owner's cloned voice is an explicit opt-in, never the default.
      voice: str(audioRaw.voice) || (mode === 'vo' || mode === 'vo+music' ? 'elevenlabs' : null),
      musicBrief: str(audioRaw.musicBrief) || null,
    },
    models: { image, video },
    personalization: {
      // ANY scene asking for the owner's face counts — a scene-level flag with
      // the global flag left false must still trigger photo resolution, or the
      // card would promise "Boss-এর ছবি" while the render gets no reference.
      useOwnerPhotos:
        Boolean(persRaw.useOwnerPhotos) || photoPaths.length > 0 || scenes.some((s) => s.usesOwnerPhoto),
      photoPaths,
    },
    scenes,
    // Burned-in captions land in M3 (Bangla PNG overlay pipeline) — until the
    // concat worker renders them, a plan must not promise them.
    captions: false,
  }
}
