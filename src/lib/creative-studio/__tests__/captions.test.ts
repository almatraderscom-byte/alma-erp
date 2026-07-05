/**
 * Phase V2 — caption engine unit tests (pure functions, fixture data).
 */
import { describe, it, expect } from 'vitest'
import {
  alignCaptions,
  buildAss,
  splitCaptionLines,
  CAPTION_LINE_MAX,
  type TimedSegment,
} from '@/lib/creative-studio/captions'

const SEGMENTS: TimedSegment[] = [
  { start: 0.5, end: 4.2, text: 'আজকে আমাদের নতুন কালেকশন এসেছে' },
  { start: 5.0, end: 9.8, text: 'বাবা ছেলের ম্যাচিং পাঞ্জাবি সেট' },
  { start: 10.5, end: 14.5, text: 'অর্ডার করতে ইনবক্স করুন' },
]

const ACCURATE =
  'আজকে আমাদের নতুন কালেকশন এসেছে — বাবা-ছেলের ম্যাচিং পাঞ্জাবি সেট। অর্ডার করতে ইনবক্স করুন।'

describe('splitCaptionLines', () => {
  it('never exceeds the max line length and never splits words', () => {
    const lines = splitCaptionLines(ACCURATE)
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(CAPTION_LINE_MAX)
    }
    expect(lines.join(' ')).toBe(ACCURATE.replace(/\s+/g, ' ').trim())
  })

  it('handles a single long word gracefully', () => {
    const lines = splitCaptionLines('সুপারক্যালিফ্রাজিলিস্টিকএক্সপিয়ালিডোশাস')
    expect(lines).toHaveLength(1)
  })
})

describe('alignCaptions', () => {
  it('covers the full accurate text across the timed windows, in order', () => {
    const cues = alignCaptions(ACCURATE, SEGMENTS)
    expect(cues.length).toBeGreaterThan(0)
    const joined = cues.map((c) => c.text).join(' ')
    expect(joined).toBe(ACCURATE.replace(/\s+/g, ' ').trim())
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start)
    }
  })

  it('keeps every cue inside its source window bounds (± the min-duration floor)', () => {
    const cues = alignCaptions(ACCURATE, SEGMENTS)
    const first = cues[0]
    const last = cues[cues.length - 1]
    expect(first.start).toBeGreaterThanOrEqual(SEGMENTS[0].start)
    expect(last.end).toBeLessThanOrEqual(SEGMENTS[SEGMENTS.length - 1].end + 0.7)
  })

  it('never produces overlapping cues', () => {
    const cues = alignCaptions(ACCURATE, SEGMENTS)
    for (let i = 0; i < cues.length - 1; i++) {
      expect(cues[i].end).toBeLessThanOrEqual(cues[i + 1].start + 0.001)
    }
  })

  it('is deterministic', () => {
    expect(alignCaptions(ACCURATE, SEGMENTS)).toEqual(alignCaptions(ACCURATE, SEGMENTS))
  })

  it('returns empty for empty text or no segments', () => {
    expect(alignCaptions('', SEGMENTS)).toEqual([])
    expect(alignCaptions(ACCURATE, [])).toEqual([])
  })

  it('puts all text in one window when whisper returns a single segment', () => {
    const cues = alignCaptions(ACCURATE, [{ start: 0, end: 15, text: 'যাই হোক' }])
    expect(cues.map((c) => c.text).join(' ')).toBe(ACCURATE.replace(/\s+/g, ' ').trim())
    expect(cues[0].start).toBe(0)
  })
})

describe('buildAss', () => {
  it('renders a valid ASS file with scaled brand style and all cues', () => {
    const cues = alignCaptions(ACCURATE, SEGMENTS)
    const ass = buildAss(cues, { width: 1080, height: 1920 })
    expect(ass).toContain('[Script Info]')
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('Noto Sans Bengali')
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues).toHaveLength(cues.length)
    // ASS timestamps look like 0:00:00.50
    expect(dialogues[0]).toMatch(/Dialogue: 0,\d:\d{2}:\d{2}\.\d{2},\d:\d{2}:\d{2}\.\d{2},Alma,/)
  })

  it('scales the font down for a 16:9 (1080-high) output', () => {
    const ass1920 = buildAss([{ start: 0, end: 2, text: 'টেস্ট' }], { width: 1080, height: 1920 })
    const ass1080 = buildAss([{ start: 0, end: 2, text: 'টেস্ট' }], { width: 1920, height: 1080 })
    const size = (s: string) => Number(s.match(/Style: Alma,[^,]+,(\d+),/)?.[1])
    expect(size(ass1080)).toBeLessThan(size(ass1920))
  })

  it('strips ASS control braces from cue text', () => {
    const ass = buildAss([{ start: 0, end: 2, text: 'ক {\\b1}খ' }], { width: 1080, height: 1920 })
    expect(ass).not.toContain('{\\b1}')
  })
})
