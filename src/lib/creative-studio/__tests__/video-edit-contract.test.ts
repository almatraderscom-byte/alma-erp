import { describe, expect, it } from 'vitest'
import {
  createDefaultVideoEditContract,
  editedDurationSec,
  isTrackOnlyRerender,
  parseVideoEditContract,
  selectVideoEditSourcePath,
} from '@/lib/creative-studio/video-edit-contract'

describe('CSE5 video edit contract', () => {
  it('trims, reorders and crops a fixture without replacing the source', () => {
    const contract = parseVideoEditContract({
      ...createDefaultVideoEditContract(20),
      segments: [
        { id: 'ending', startSec: 12, endSec: 18, order: 0 },
        { id: 'opening', startSec: 2, endSec: 7, order: 1 },
      ],
      crop: { aspect: '9:16', focusX: 0.7, focusY: 0.4 },
      rerender: ['visual', 'cover'],
    })
    expect(contract.segments.map((segment) => segment.id)).toEqual(['ending', 'opening'])
    expect(contract.crop).toEqual({ aspect: '9:16', focusX: 0.7, focusY: 0.4, safeZone: true })
    expect(contract.preserveVisualSource).toBe(true)
    expect(editedDurationSec(contract)).toBe(11)
  })

  it('edits caption and voiceover timing deterministically', () => {
    const input = {
      ...createDefaultVideoEditContract(10),
      transcript: [
        { id: 'b', track: 'voiceover', startSec: 3, endSec: 4.5, text: 'দ্বিতীয় লাইন' },
        { id: 'a', track: 'caption', startSec: 0.5, endSec: 2, text: 'প্রথম লাইন' },
      ],
      captionPlacement: 'top',
      rerender: ['captions', 'audio'],
    }
    const first = parseVideoEditContract(input)
    expect(first).toEqual(parseVideoEditContract(input))
    expect(first.transcript.map((cue) => cue.id)).toEqual(['a', 'b'])
    expect(first.captionPlacement).toBe('top')
    expect(isTrackOnlyRerender(first)).toBe(true)
  })

  it('clamps safe controls and rejects malformed timing', () => {
    const contract = parseVideoEditContract({
      ...createDefaultVideoEditContract(8),
      volumes: { original: 2, music: -1, voiceover: 0.75 },
      cover: { atSec: 99 },
    })
    expect(contract.volumes).toEqual({ original: 1, music: 0, voiceover: 0.75 })
    expect(contract.cover.atSec).toBe(8)
    expect(() => parseVideoEditContract({
      ...createDefaultVideoEditContract(8),
      segments: [{ id: 'bad', startSec: 2, endSec: 2.01, order: 0 }],
    })).toThrow('segment_too_short')
  })

  it('preserves the newest visible edit for track-only rerenders', () => {
    const result = {
      storagePath: 'generated/source.mp4',
      editedPath: 'generated/timeline.mp4',
      brandedPath: 'generated/finished.mp4',
    }
    expect(selectVideoEditSourcePath(result, false)).toBe('generated/source.mp4')
    expect(selectVideoEditSourcePath(result, true)).toBe('generated/finished.mp4')
  })
})
