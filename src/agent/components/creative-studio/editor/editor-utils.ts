import type {
  EditorClip,
  EditorCompositionSnapshot,
  EditorTrack,
} from '@/lib/creative-studio/editor-agent'
import type { EditorSelection } from './ui-types'

export function formatEditorTime(seconds: number): string {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(value / 60)
  const wholeSeconds = Math.floor(value % 60)
  const frames = Math.floor((value % 1) * 10)
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${frames}`
}

export function selectedEditorClip(
  snapshot: EditorCompositionSnapshot,
  selection: EditorSelection | null,
): { track: EditorTrack; clip: EditorClip; index: number } | null {
  if (!selection) return null
  const track = snapshot.tracks.find((candidate) => candidate.id === selection.trackId)
  if (!track) return null
  const index = track.clips.findIndex((candidate) => candidate.id === selection.clipId)
  if (index < 0) return null
  return { track, clip: track.clips[index], index }
}

export function activeVisualClip(
  snapshot: EditorCompositionSnapshot,
  playheadSec: number,
): EditorClip | null {
  const visualTracks = snapshot.tracks.filter(
    (track) => track.kind === 'video' || track.kind === 'overlay',
  )
  for (const track of visualTracks) {
    const match = track.clips.find(
      (clip) => playheadSec >= clip.startSec && playheadSec < clip.endSec,
    )
    if (match && track.kind === 'video') return match
  }
  return visualTracks.flatMap((track) => track.clips)[0] ?? null
}

export function defaultEditorSelection(
  snapshot: EditorCompositionSnapshot,
): EditorSelection | null {
  const video = snapshot.tracks.find((track) => track.kind === 'video')?.clips[0]
  if (video) return { trackId: video.trackId, clipId: video.id }
  const first = snapshot.tracks.flatMap((track) => track.clips)[0]
  return first ? { trackId: first.trackId, clipId: first.id } : null
}

export function trackKindLabel(kind: EditorTrack['kind']): string {
  const labels: Record<EditorTrack['kind'], string> = {
    video: 'Video',
    overlay: 'Image / Overlay',
    caption: 'Captions',
    voice: 'Voice',
    music: 'Music',
    sfx: 'SFX',
  }
  return labels[kind]
}

export function statusLabel(status: EditorClip['status']): string {
  const labels: Record<EditorClip['status'], string> = {
    local: 'Local',
    queued: 'Queued',
    running: 'Running',
    ready: 'Ready',
    failed: 'Failed',
    needs_review: 'Needs review',
  }
  return labels[status]
}
