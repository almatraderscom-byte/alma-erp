import { describe, expect, it } from 'vitest'
import {
  applyEditorOperations,
  createEditorFixtureSnapshot,
  type EditorLocalOperation,
} from '@/lib/creative-studio/editor-agent'

const BASE = {
  effect: 'local_reversible' as const,
  estimatedCostBdt: 0 as const,
  requiredRole: 'creator' as const,
}

describe('editor local operation reducer', () => {
  it('applies caption, trim, split, move, transform and volume as one immutable batch', () => {
    const snapshot = createEditorFixtureSnapshot()
    const operations: EditorLocalOperation[] = [
      {
        ...BASE,
        id: 'op-caption-text',
        label: 'Caption text',
        kind: 'caption.text.set',
        target: { trackId: 'track-caption', clipId: 'caption-primary' },
        before: 'ঈদের নতুন গল্প',
        after: 'ঈদের অফার আজই',
      },
      {
        ...BASE,
        id: 'op-caption-timing',
        label: 'Caption timing',
        kind: 'caption.timing.set',
        target: { trackId: 'track-caption', clipId: 'caption-primary' },
        before: { startSec: 2.4, endSec: 8.4 },
        after: { startSec: 1.2, endSec: 7.2 },
      },
      {
        ...BASE,
        id: 'op-trim',
        label: 'Trim opening',
        kind: 'clip.trim',
        target: { trackId: 'track-video', clipId: 'clip-hero' },
        before: {
          startSec: 0,
          endSec: 4.8,
          sourceStartSec: 0,
          sourceEndSec: 4.8,
        },
        after: {
          startSec: 0,
          endSec: 4,
          sourceStartSec: 0,
          sourceEndSec: 4,
        },
      },
      {
        ...BASE,
        id: 'op-transform',
        label: 'Transform opening',
        kind: 'node.transform.set',
        target: { trackId: 'track-video', clipId: 'clip-hero' },
        before: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        after: { x: 0.1, y: -0.2, scale: 1.1, rotation: 2, opacity: 0.9 },
      },
      {
        ...BASE,
        id: 'op-volume',
        label: 'Lower music',
        kind: 'track.volume.set',
        target: { trackId: 'track-music', clipId: 'music-eid-pulse' },
        before: 0.18,
        after: 0.12,
      },
      {
        ...BASE,
        id: 'op-move',
        label: 'Move family first',
        kind: 'clip.move',
        target: { trackId: 'track-video', clipId: 'clip-family' },
        before: { index: 1 },
        after: { index: 0 },
      },
      {
        ...BASE,
        id: 'op-split',
        label: 'Split opening',
        kind: 'clip.split',
        target: { trackId: 'track-video', clipId: 'clip-hero' },
        before: { clipId: 'clip-hero', startSec: 0, endSec: 4 },
        after: {
          leftClipId: 'clip-hero',
          rightClipId: 'clip-hero-b',
          splitAtSec: 2,
        },
      },
    ]

    const result = applyEditorOperations(snapshot, operations)
    const video = result.tracks.find((track) => track.id === 'track-video')!
    const caption = result.tracks.find((track) => track.id === 'track-caption')!
    const music = result.tracks.find((track) => track.id === 'track-music')!

    expect(snapshot.tracks[0].clips).toHaveLength(3)
    expect(video.clips.map((clip) => clip.id)).toEqual([
      'clip-family',
      'clip-hero',
      'clip-hero-b',
      'clip-close',
    ])
    expect(video.clips[1]).toMatchObject({
      endSec: 2,
      sourceEndSec: 2,
      transform: { x: 0.1, y: -0.2, scale: 1.1, rotation: 2, opacity: 0.9 },
    })
    expect(video.clips[2]).toMatchObject({ startSec: 2, sourceStartSec: 2 })
    expect(caption.clips[0]).toMatchObject({
      text: 'ঈদের অফার আজই',
      startSec: 1.2,
      endSec: 7.2,
    })
    expect(music.clips[0].volume).toBe(0.12)
  })

  it('rejects non-finite values and duplicate split clip IDs', () => {
    const snapshot = createEditorFixtureSnapshot()
    expect(() => applyEditorOperations(snapshot, [{
      ...BASE,
      id: 'op-invalid-volume',
      label: 'Invalid volume',
      kind: 'track.volume.set',
      target: { trackId: 'track-music', clipId: 'music-eid-pulse' },
      before: 0.18,
      after: Number.NaN,
    }])).toThrow('operation_value_invalid')

    expect(() => applyEditorOperations(snapshot, [{
      ...BASE,
      id: 'op-duplicate-split',
      label: 'Duplicate split',
      kind: 'clip.split',
      target: { trackId: 'track-video', clipId: 'clip-hero' },
      before: { clipId: 'clip-hero', startSec: 0, endSec: 4.8 },
      after: {
        leftClipId: 'clip-hero',
        rightClipId: 'clip-family',
        splitAtSec: 2,
      },
    }])).toThrow('duplicate_split_clip_id')
  })
})
