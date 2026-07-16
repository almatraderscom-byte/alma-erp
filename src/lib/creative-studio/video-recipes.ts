/**
 * Phase V1 — deterministic video Recipe Engine.
 *
 * The owner shoots 1–2 min videos on his phone; a Recipe turns them into reels
 * with ZERO LLM involvement: hard-coded clip lengths, transition style, crop
 * rule and output aspect. The cut plan is a PURE function of (video duration,
 * scene-change timestamps, recipe, target length) — same input, same plan —
 * and is unit-tested like the family chain.
 *
 * The VPS worker detects scene changes with ffmpeg (scdet) and asks
 * /api/assistant/internal/video-cut-plan for the plan, so this file stays the
 * single source of truth for the algorithm and every recipe's parameters.
 */

export type VideoRecipeId = 'family_shoot' | 'product_showcase' | 'offer_promo'
export type VideoAspect = '9:16' | '1:1' | '16:9'
export type VideoTransition = 'cut' | 'crossfade'

export type VideoRecipe = {
  id: VideoRecipeId
  label: string
  labelBn: string
  /** what kind of shoot this recipe is for — shown on the recipe card */
  descriptionBn: string
  /** seconds taken from each selected scene */
  clipSec: number
  /** skip the (often shaky) first moments of a scene before cutting */
  skipInSec: number
  /** scenes shorter than this are unstable clips — ignore them */
  minSceneSec: number
  transition: VideoTransition
  /** crossfade duration; 0 for hard cuts */
  fadeSec: number
  /** selectable output lengths (seconds) */
  targets: number[]
  defaultTarget: number
}

export const VIDEO_RECIPES: VideoRecipe[] = [
  {
    id: 'family_shoot',
    label: 'Family Shoot',
    labelBn: 'ফ্যামিলি শুট',
    descriptionBn: 'বাবা-ছেলে / মা-মেয়ে ম্যাচিং শুট — ধীর গতি, নরম ক্রসফেড',
    clipSec: 5,
    skipInSec: 0.6,
    minSceneSec: 2.5,
    transition: 'crossfade',
    fadeSec: 0.5,
    targets: [15, 30, 60],
    defaultTarget: 30,
  },
  {
    id: 'product_showcase',
    label: 'Product Showcase',
    labelBn: 'প্রোডাক্ট শোকেস',
    descriptionBn: 'প্রোডাক্ট ঘুরিয়ে দেখানো শুট — মাঝারি গতি, পরিষ্কার কাট',
    clipSec: 3,
    skipInSec: 0.4,
    minSceneSec: 1.5,
    transition: 'cut',
    fadeSec: 0,
    targets: [15, 30, 60],
    defaultTarget: 30,
  },
  {
    id: 'offer_promo',
    label: 'Offer Promo',
    labelBn: 'অফার প্রোমো',
    descriptionBn: 'অফার/ঘোষণা — দ্রুত গতি, ঝটপট কাটে এনার্জি',
    clipSec: 2,
    skipInSec: 0.3,
    minSceneSec: 1,
    transition: 'cut',
    fadeSec: 0,
    targets: [15, 30],
    defaultTarget: 15,
  },
]

/** Client-safe mirror of content-engine estimateReelCostBdt (that module pulls
 * prisma via brand-identity, so the Studio UI can't import it). Veo ≈ $0.15/s. */
export function reelCostBdt(durationSec: number, usdToBdt = 125): number {
  return Math.round(durationSec * 0.15 * usdToBdt)
}

export function getVideoRecipe(id: string): VideoRecipe | null {
  return VIDEO_RECIPES.find((r) => r.id === id) ?? null
}

export const VIDEO_ASPECTS: Array<{ id: VideoAspect; label: string; width: number; height: number }> = [
  { id: '9:16', label: 'রিল (9:16)', width: 1080, height: 1920 },
  { id: '1:1', label: 'স্কয়ার (1:1)', width: 1080, height: 1080 },
  { id: '16:9', label: 'ওয়াইড (16:9)', width: 1920, height: 1080 },
]

/** Upload constraints for the owner's phone-shot originals (signed direct upload). */
export const VIDEO_UPLOAD_MAX_BYTES = 500 * 1024 * 1024 // ~500 MB, 1–2 min iPhone HEVC
export const VIDEO_UPLOAD_EXTENSIONS = ['mp4', 'mov', 'm4v'] as const

// ── Phase V2: caption + audio layer (still zero LLM) ────────────────────────

/** Owner-approved music beds only (Islamic guardrail) — tagged by vibe. */
export const MUSIC_VIBES = [
  { id: 'celebration', labelBn: 'উৎসব' },
  { id: 'calm', labelBn: 'শান্ত' },
  { id: 'energetic', labelBn: 'এনার্জেটিক' },
] as const
export type MusicVibe = (typeof MUSIC_VIBES)[number]['id']

export const MUSIC_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
export const MUSIC_UPLOAD_EXTENSIONS = ['mp3', 'm4a', 'wav', 'aac'] as const

/**
 * How the reel's soundtrack is built:
 *  original    — the shoot's own audio, untouched (V1 behaviour)
 *  music       — music bed replaces the original audio entirely
 *  music_duck  — original speech stays on top; music auto-ducks under it
 */
export type VideoAudioMode = 'original' | 'music' | 'music_duck'
export const AUDIO_MODES: Array<{ id: VideoAudioMode; labelBn: string }> = [
  { id: 'original', labelBn: 'শুটের অডিও' },
  { id: 'music', labelBn: 'শুধু মিউজিক' },
  { id: 'music_duck', labelBn: 'কথা + মিউজিক' },
]

export const VOICEOVER_MAX_CHARS = 220

export type VideoEditOptions = {
  /** burn Bangla captions (Whisper transcription — mechanical, allowed) */
  captions?: boolean
  audioMode?: VideoAudioMode
  /** picked track id, or 'auto' for the deterministic round-robin */
  musicTrackId?: string
  /** owner-typed line, rendered with the existing Google Bangla TTS — never LLM-written */
  voiceoverText?: string
  /** logo intro/outro stings (pre-rendered once per aspect, concatenated) */
  stings?: boolean
  /** V4 (per-run opt-in, OFF default): Gemini suggests highlight timestamps —
   * only ADDED to scdet's cuts; the deterministic planner still decides */
  aiAssist?: boolean
}

export type CutSegment = {
  /** source start time (seconds) */
  start: number
  /** source end time (seconds) */
  end: number
}

export type CutPlan = {
  segments: CutSegment[]
  /** final output length after transition overlap */
  totalSec: number
  transition: VideoTransition
  fadeSec: number
}

const MIN_SEGMENT_SEC = 0.8
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Build scene intervals from raw scene-change timestamps: clamp into the video,
 * sort, dedupe near-identical cuts, and pair into [start, end) intervals.
 */
function sceneIntervals(durationSec: number, sceneChanges: number[]): Array<{ start: number; end: number }> {
  const cuts = Array.from(
    new Set(
      sceneChanges
        .filter((t) => Number.isFinite(t) && t > 0.2 && t < durationSec - 0.2)
        .map((t) => round2(t)),
    ),
  ).sort((a, b) => a - b)

  const bounds = [0, ...cuts.filter((t, i, arr) => i === 0 || t - arr[i - 1] >= 0.3), durationSec]
  const intervals: Array<{ start: number; end: number }> = []
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 0.05) intervals.push({ start: bounds[i], end: bounds[i + 1] })
  }
  return intervals
}

/** Evenly-spread index selection: 0 … n-1 covering first and last. */
function spreadIndices(n: number, k: number): number[] {
  if (k >= n) return Array.from({ length: n }, (_, i) => i)
  if (k === 1) return [Math.floor(n / 2)]
  const picked: number[] = []
  for (let i = 0; i < k; i++) {
    const idx = Math.round((i * (n - 1)) / (k - 1))
    if (picked.length === 0 || idx > picked[picked.length - 1]) picked.push(idx)
  }
  return picked
}

/**
 * The deterministic cut planner. Pure — no I/O, no randomness, no clock.
 *
 * Given the video duration, ffmpeg scene-change timestamps and a recipe, plan
 * which source ranges make up a `targetSec`-long output:
 *  1. build scene intervals, drop ones shorter than the recipe's minSceneSec
 *  2. choose K = enough clips of recipe.clipSec to fill the target (accounting
 *     crossfade overlap), spread evenly across the usable scenes
 *  3. cut clipSec from each chosen scene (skipping its shaky first moments)
 *  4. trim/extend the tail so the total lands on target (±1s)
 *
 * A video shorter than the target becomes one full-length segment — the output
 * is simply as long as the material allows. No scene changes at all (a static
 * shot) falls back to evenly-spaced windows across the timeline.
 */
export function planCuts(input: {
  recipe: VideoRecipe
  durationSec: number
  sceneChanges: number[]
  targetSec: number
}): CutPlan {
  const { recipe, sceneChanges } = input
  const durationSec = round2(input.durationSec)
  const targetSec = Math.max(5, round2(input.targetSec))
  if (!Number.isFinite(durationSec) || durationSec <= 0.5) {
    throw new Error('invalid_duration')
  }

  const fade = recipe.transition === 'crossfade' ? recipe.fadeSec : 0

  // Not enough material: use the whole video as a single segment.
  if (durationSec <= targetSec + 1) {
    return {
      segments: [{ start: 0, end: durationSec }],
      totalSec: durationSec,
      transition: recipe.transition,
      fadeSec: fade,
    }
  }

  const all = sceneIntervals(durationSec, sceneChanges)
  let usable = all.filter((iv) => iv.end - iv.start >= recipe.minSceneSec)
  // Every scene too short (or a static shot with no cuts at all): treat the
  // whole timeline as one long take and let the window split below pace it.
  if (usable.length === 0) usable = [{ start: 0, end: durationSec }]

  // clips needed so that K*clip - (K-1)*fade >= target
  const perClip = recipe.clipSec - fade
  const clipsNeeded = Math.max(1, Math.ceil((targetSec - fade) / perClip))

  // Candidate windows: each usable scene contributes as many clip-sized
  // windows as it can hold (a long take yields several), so a shoot with few
  // scene changes can still fill a long target.
  const windows: Array<{ start: number; end: number; sceneEnd: number }> = []
  for (const iv of usable) {
    const len = iv.end - iv.start
    const count = Math.max(1, Math.floor((len - recipe.skipInSec) / recipe.clipSec))
    for (let j = 0; j < count; j++) {
      const skip = j === 0 ? Math.min(recipe.skipInSec, Math.max(0, len - recipe.clipSec)) : recipe.skipInSec
      const start = round2(iv.start + skip + j * recipe.clipSec)
      const end = round2(Math.min(start + recipe.clipSec, iv.end))
      if (end - start >= MIN_SEGMENT_SEC) windows.push({ start, end, sceneEnd: iv.end })
    }
  }
  if (windows.length === 0) {
    windows.push({ start: 0, end: round2(Math.min(recipe.clipSec, durationSec)), sceneEnd: durationSec })
  }

  const chosen = spreadIndices(windows.length, clipsNeeded).map((i) => windows[i])

  const segments: CutSegment[] = chosen.map((w) => ({ start: w.start, end: w.end }))
  const total = (segs: CutSegment[]) =>
    round2(segs.reduce((s, seg) => s + (seg.end - seg.start), 0) - Math.max(0, segs.length - 1) * fade)

  // Tail adjustment: trim overshoot (dropping tail clips if needed), or extend
  // the last clip inside its own scene to cover a small undershoot.
  let excess = total(segments) - targetSec
  while (excess > 0.75 && segments.length > 0) {
    const last = segments[segments.length - 1]
    const lastLen = last.end - last.start
    if (lastLen - excess >= MIN_SEGMENT_SEC) {
      last.end = round2(last.end - excess)
    } else if (segments.length > 1) {
      segments.pop()
    } else {
      last.end = round2(last.start + Math.max(MIN_SEGMENT_SEC, lastLen - excess))
      break
    }
    excess = total(segments) - targetSec
  }
  if (excess < -0.75 && segments.length === chosen.length) {
    const last = segments[segments.length - 1]
    const ceiling = chosen[chosen.length - 1].sceneEnd
    last.end = round2(Math.min(last.end - excess, ceiling, durationSec))
  }

  return {
    segments,
    totalSec: total(segments),
    transition: recipe.transition,
    fadeSec: fade,
  }
}

// ── CS11: video hardening — pure, unit-tested spec (worker mirrors) ──────────

/** Social-platform loudness target (roadmap): −14 LUFS integrated, TP ≤ −1 dBTP. */
export const LOUDNESS_TARGET = { integratedLufs: -14, truePeakDb: -1, lra: 11 } as const

/** ffmpeg loudnorm filter string built from the locked target. */
export const LOUDNORM_FILTER = `loudnorm=I=${LOUDNESS_TARGET.integratedLufs}:TP=${LOUDNESS_TARGET.truePeakDb}:LRA=${LOUDNESS_TARGET.lra}`

/**
 * Owner-friendly Bangla video error codes. RAW ffmpeg/provider text never
 * reaches the owner's Gallery — the full detail stays in worker logs (admin
 * diagnostics). Mirrored in worker/src/video-qc.mjs (keep in sync).
 */
export const VIDEO_ERRORS_BN: Record<string, string> = {
  VEO_TIMEOUT: 'ভিডিও তৈরি সময়সীমা পার করেছে — আবার চালান (কোড: VEO_TIMEOUT)',
  VEO_FAILED: 'ভিডিও ইঞ্জিন ব্যর্থ — একটু পরে আবার চালান (কোড: VEO_FAILED)',
  VEO_DOWNLOAD: 'তৈরি ভিডিও নামানো যায়নি — আবার চালালে একই জেনারেশন resume হবে (কোড: VEO_DOWNLOAD)',
  QC_BLACK: 'ভিডিওতে কালো ফ্রেম বেশি — বাতিল করে নতুন করে চালানো হয়েছে/চালান (কোড: QC_BLACK)',
  QC_FROZEN: 'ভিডিও আটকে-যাওয়া (frozen) ফ্রেমে ভরা — বাতিল (কোড: QC_FROZEN)',
  QC_DURATION: 'ভিডিওর দৈর্ঘ্য ঠিক আসেনি — বাতিল (কোড: QC_DURATION)',
  FFMPEG_RENDER: 'ভিডিও প্রসেসিং ব্যর্থ — আবার চালান; বারবার হলে সোর্স ভিডিওটা বদলান (কোড: FFMPEG_RENDER)',
  SOURCE_DOWNLOAD: 'সোর্স ভিডিও পড়া যায়নি — আবার আপলোড করুন (কোড: SOURCE_DOWNLOAD)',
  UNKNOWN: 'ভিডিওর কাজ ব্যর্থ — আবার চালান (কোড: UNKNOWN)',
}

/** Map a raw error string to a safe Bangla message. Pure and deterministic. */
export function sanitizeVideoErrorMessage(raw: string | null | undefined): string {
  const s = (raw ?? '').toLowerCase()
  if (!s) return VIDEO_ERRORS_BN.UNKNOWN
  if (s.includes('timed out') && s.includes('veo')) return VIDEO_ERRORS_BN.VEO_TIMEOUT
  if (s.includes('veo download')) return VIDEO_ERRORS_BN.VEO_DOWNLOAD
  if (s.includes('veo')) return VIDEO_ERRORS_BN.VEO_FAILED
  if (s.includes('qc_black')) return VIDEO_ERRORS_BN.QC_BLACK
  if (s.includes('qc_frozen')) return VIDEO_ERRORS_BN.QC_FROZEN
  if (s.includes('qc_duration')) return VIDEO_ERRORS_BN.QC_DURATION
  if (s.includes('download failed') || s.includes('sourcedownload')) return VIDEO_ERRORS_BN.SOURCE_DOWNLOAD
  if (s.includes('ffmpeg') || s.includes('ffprobe') || s.includes('/tmp/') || s.includes('spawn')) return VIDEO_ERRORS_BN.FFMPEG_RENDER
  return VIDEO_ERRORS_BN.UNKNOWN
}

/** True when a stored error string looks like raw internals the owner must not see. */
export function looksLikeRawInternalError(msg: string | null | undefined): boolean {
  if (!msg) return false
  if (msg.includes('কোড:')) return false // already a sanitized Bangla message
  return /ffmpeg|ffprobe|\/tmp\/|\bspawn\b|ENOENT|maxBuffer|exit code|stderr/i.test(msg)
}

export type CoverMetric = { index: number; sharpness: number; brightness: number }

/**
 * CS11 — deterministic cover ordering: sharp and well-exposed frames first.
 * score = sharpness normalized − penalty for too-dark/too-bright frames.
 * Manual override always wins in the UI; this only sets the DEFAULT order.
 */
export function scoreCoverOrder(metrics: CoverMetric[]): number[] {
  const maxSharp = Math.max(1, ...metrics.map((m) => m.sharpness))
  return [...metrics]
    .map((m) => {
      const exposurePenalty = m.brightness < 40 || m.brightness > 215 ? 0.5 : 0
      return { index: m.index, score: m.sharpness / maxSharp - exposurePenalty }
    })
    .sort((a, b) => b.score - a.score)
    .map((m) => m.index)
}

/** Caption safe area: overlays must sit within the bottom band but above UI chrome. */
export const CAPTION_SAFE_AREA = { minMarginVPx: 96, maxBottomFraction: 0.28 } as const

export function clampCaptionMarginV(marginV: number, videoHeight: number): number {
  const maxMargin = Math.round(videoHeight * CAPTION_SAFE_AREA.maxBottomFraction)
  return Math.min(Math.max(marginV, CAPTION_SAFE_AREA.minMarginVPx), maxMargin)
}
