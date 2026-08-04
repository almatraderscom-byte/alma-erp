/**
 * CSE5 timeline-lite contract. It is intentionally much smaller than an NLE:
 * one source, ordered trims, one crop, three volume faders, timed transcript,
 * caption placement and one cover timestamp.
 */

export const VIDEO_EDIT_CONTRACT_VERSION = 1 as const
export const VIDEO_EDIT_TRACKS = ['visual', 'captions', 'audio', 'cover'] as const
export type VideoEditTrack = (typeof VIDEO_EDIT_TRACKS)[number]
export const CAPTION_PLACEMENTS = ['top', 'center', 'bottom'] as const
export type CaptionPlacement = (typeof CAPTION_PLACEMENTS)[number]
export const VIDEO_CROP_ASPECTS = ['original', '9:16', '4:5', '1:1', '16:9'] as const
export type VideoCropAspect = (typeof VIDEO_CROP_ASPECTS)[number]

export type TimelineSegment = {
  id: string
  startSec: number
  endSec: number
  order: number
}

export type TranscriptCue = {
  id: string
  track: 'caption' | 'voiceover'
  startSec: number
  endSec: number
  text: string
}

export type VideoEditContract = {
  version: typeof VIDEO_EDIT_CONTRACT_VERSION
  sourceDurationSec: number
  preserveVisualSource: true
  segments: TimelineSegment[]
  crop: {
    aspect: VideoCropAspect
    focusX: number
    focusY: number
    safeZone: true
  }
  volumes: {
    original: number
    music: number
    voiceover: number
  }
  captionPlacement: CaptionPlacement
  transcript: TranscriptCue[]
  cover: { atSec: number }
  rerender: VideoEditTrack[]
}

const round = (value: number, digits = 3) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const finite = (value: unknown, fallback: number) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function editedDurationSec(contract: Pick<VideoEditContract, 'segments'>): number {
  return round(contract.segments.reduce((sum, segment) => sum + segment.endSec - segment.startSec, 0))
}

export function createDefaultVideoEditContract(durationSec: number): VideoEditContract {
  const duration = clamp(round(finite(durationSec, 15)), 0.5, 7_200)
  return {
    version: VIDEO_EDIT_CONTRACT_VERSION,
    sourceDurationSec: duration,
    preserveVisualSource: true,
    segments: [{ id: 'clip-1', startSec: 0, endSec: duration, order: 0 }],
    crop: { aspect: 'original', focusX: 0.5, focusY: 0.5, safeZone: true },
    volumes: { original: 1, music: 0.35, voiceover: 1 },
    captionPlacement: 'bottom',
    transcript: [],
    cover: { atSec: Math.min(0.5, duration) },
    rerender: ['visual', 'captions', 'audio', 'cover'],
  }
}

export function parseVideoEditContract(input: unknown, fallbackDurationSec = 15): VideoEditContract {
  const raw = object(input)
  const sourceDurationSec = clamp(round(finite(raw.sourceDurationSec, fallbackDurationSec)), 0.5, 7_200)
  const rawSegments = Array.isArray(raw.segments) ? raw.segments.slice(0, 32) : []
  if (rawSegments.length === 0) throw new Error('segments_required')

  const segments = rawSegments.map((candidate, index) => {
    const segment = object(candidate)
    const startSec = round(clamp(finite(segment.startSec, 0), 0, sourceDurationSec))
    const endSec = round(clamp(finite(segment.endSec, sourceDurationSec), 0, sourceDurationSec))
    if (endSec - startSec < 0.1) throw new Error('segment_too_short')
    return {
      id: String(segment.id ?? `clip-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || `clip-${index + 1}`,
      startSec,
      endSec,
      order: Math.max(0, Math.round(finite(segment.order, index))),
    }
  }).sort((a, b) => a.order - b.order)
  if (new Set(segments.map((segment) => segment.id)).size !== segments.length) throw new Error('duplicate_segment_id')
  if (new Set(segments.map((segment) => segment.order)).size !== segments.length) throw new Error('duplicate_segment_order')

  const outputDuration = editedDurationSec({ segments })
  if (outputDuration > 600) throw new Error('edited_duration_too_long')

  const cropRaw = object(raw.crop)
  const aspect = VIDEO_CROP_ASPECTS.includes(cropRaw.aspect as VideoCropAspect)
    ? cropRaw.aspect as VideoCropAspect
    : 'original'
  const volumesRaw = object(raw.volumes)
  const captionPlacement = CAPTION_PLACEMENTS.includes(raw.captionPlacement as CaptionPlacement)
    ? raw.captionPlacement as CaptionPlacement
    : 'bottom'
  const rawTranscript = Array.isArray(raw.transcript) ? raw.transcript.slice(0, 100) : []
  const transcript = rawTranscript.map((candidate, index) => {
    const cue = object(candidate)
    const startSec = round(clamp(finite(cue.startSec, 0), 0, outputDuration))
    const endSec = round(clamp(finite(cue.endSec, outputDuration), 0, outputDuration))
    const text = String(cue.text ?? '').trim().slice(0, 240)
    if (!text) throw new Error('cue_text_required')
    if (endSec - startSec < 0.1) throw new Error('cue_timing_invalid')
    return {
      id: String(cue.id ?? `cue-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || `cue-${index + 1}`,
      track: cue.track === 'voiceover' ? 'voiceover' as const : 'caption' as const,
      startSec,
      endSec,
      text,
    }
  }).sort((a, b) => a.startSec - b.startSec)

  const rerender = Array.from(new Set(
    (Array.isArray(raw.rerender) ? raw.rerender : VIDEO_EDIT_TRACKS)
      .filter((track): track is VideoEditTrack => VIDEO_EDIT_TRACKS.includes(track as VideoEditTrack)),
  ))
  if (rerender.length === 0) throw new Error('rerender_track_required')

  const coverRaw = object(raw.cover)
  return {
    version: VIDEO_EDIT_CONTRACT_VERSION,
    sourceDurationSec,
    preserveVisualSource: true,
    segments,
    crop: {
      aspect,
      focusX: round(clamp(finite(cropRaw.focusX, 0.5), 0, 1)),
      focusY: round(clamp(finite(cropRaw.focusY, 0.5), 0, 1)),
      safeZone: true,
    },
    volumes: {
      original: round(clamp(finite(volumesRaw.original, 1), 0, 1)),
      music: round(clamp(finite(volumesRaw.music, 0.35), 0, 1)),
      voiceover: round(clamp(finite(volumesRaw.voiceover, 1), 0, 1)),
    },
    captionPlacement,
    transcript,
    cover: { atSec: round(clamp(finite(coverRaw.atSec, 0.5), 0, outputDuration)) },
    rerender,
  }
}

export function isTrackOnlyRerender(contract: VideoEditContract): boolean {
  return !contract.rerender.includes('visual')
}

/**
 * Visual rerenders always derive from the immutable first render. Track-only
 * rerenders instead preserve the latest visible edit, where brandedPath is
 * newer than a prior editedPath.
 */
export function selectVideoEditSourcePath(
  result: Record<string, unknown>,
  preferLatestVisible: boolean,
): string | undefined {
  const keys = preferLatestVisible
    ? ['brandedPath', 'editedPath', 'storagePath']
    : ['storagePath', 'editedPath', 'brandedPath']
  for (const key of keys) {
    const path = result[key]
    if (typeof path === 'string' && path.length > 0) return path
  }
  return undefined
}
