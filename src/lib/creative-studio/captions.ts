/**
 * Phase V2 — deterministic Bangla caption engine.
 *
 * Whisper gives us TWO things: accurate Bangla text (gpt-4o-transcribe, no
 * timestamps) and timed-but-sloppier segments (whisper-1 verbose_json). These
 * pure functions marry them mechanically — no LLM judgment anywhere:
 *
 *   alignCaptions()  distributes the accurate text across the timed windows
 *                    proportionally by each window's share of the sloppy text
 *   buildAss()       renders the cues as an ASS subtitle file in the brand
 *                    style (bundled Noto Sans Bengali, burned in by the worker)
 *
 * Both are unit-tested like the cut planner; the worker only writes the .ass
 * file to disk and runs ffmpeg's subtitles filter.
 */

export type TimedSegment = {
  start: number
  end: number
  /** whisper-1's (possibly sloppy) text for this window — used only for proportions */
  text: string
}

export type CaptionCue = {
  start: number
  end: number
  text: string
}

/** Max characters per caption line — reels are 9:16, keep lines short. */
export const CAPTION_LINE_MAX = 34
const MIN_CUE_SEC = 0.6
const round2 = (n: number) => Math.round(n * 100) / 100

/** Split text into caption-sized lines on word boundaries (never mid-word). */
export function splitCaptionLines(text: string, maxLen = CAPTION_LINE_MAX): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if ((current + ' ' + word).length <= maxLen) {
      current += ' ' + word
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * Map the ACCURATE transcript onto the TIMED windows.
 *
 * Each timed segment claims a share of the accurate text proportional to its
 * share of the sloppy text's length (both transcribe the same speech, so the
 * proportions track even when the words differ). The claimed text is then cut
 * on word boundaries and split into per-line cues spread evenly inside the
 * window. Deterministic: same inputs, same cues.
 */
export function alignCaptions(accurateText: string, segments: TimedSegment[]): CaptionCue[] {
  const text = accurateText.trim().replace(/\s+/g, ' ')
  if (!text) return []

  const valid = segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start > 0.05)
    .sort((a, b) => a.start - b.start)
  if (valid.length === 0) return []

  const words = text.split(' ')
  const sloppyTotal = valid.reduce((sum, s) => sum + Math.max(1, s.text.trim().length), 0)

  const cues: CaptionCue[] = []
  let wordIdx = 0
  for (let i = 0; i < valid.length; i++) {
    const seg = valid[i]
    const isLast = i === valid.length - 1
    let segText: string
    if (isLast) {
      segText = words.slice(wordIdx).join(' ')
      wordIdx = words.length
    } else {
      const share = Math.max(1, seg.text.trim().length) / sloppyTotal
      let take = Math.max(1, Math.round(share * words.length))
      take = Math.min(take, words.length - wordIdx)
      segText = words.slice(wordIdx, wordIdx + take).join(' ')
      wordIdx += take
    }
    if (!segText) continue

    // one cue per caption line, spread evenly across the window
    const lines = splitCaptionLines(segText)
    const segDur = seg.end - seg.start
    const per = segDur / lines.length
    lines.forEach((line, j) => {
      const start = round2(seg.start + j * per)
      const end = round2(j === lines.length - 1 ? seg.end : seg.start + (j + 1) * per)
      cues.push({ start, end: Math.max(end, round2(start + MIN_CUE_SEC)), text: line })
    })
    if (wordIdx >= words.length) break
  }

  // clamp overlaps introduced by the MIN_CUE_SEC floor
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start
  }
  return cues.filter((c) => c.end - c.start > 0.1)
}

/** Brand caption style — hard constants, owner-approved look. */
export const CAPTION_STYLE = {
  fontName: 'Noto Sans Bengali',
  fontSize: 64, // PlayResY 1920 → readable reel captions
  primaryColour: '&H00FFFFFF', // white
  outlineColour: '&H00303030', // near-black outline
  backColour: '&H60000000',
  outline: 3,
  shadow: 1,
  marginV: 220, // keep clear of platform UI at the bottom of reels
} as const

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const cs = Math.round((sec - Math.floor(sec)) * 100)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`
}

/** Render cues as a complete ASS file sized for the given output. */
export function buildAss(
  cues: CaptionCue[],
  output: { width: number; height: number },
): string {
  const s = CAPTION_STYLE
  // scale font/margins from the 1080×1920 reference to the actual output
  const scale = output.height / 1920
  const fontSize = Math.round(s.fontSize * scale)
  const marginV = Math.round(s.marginV * scale)
  const outline = Math.max(2, Math.round(s.outline * scale))

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${output.width}`,
    `PlayResY: ${output.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Alma,${s.fontName},${fontSize},${s.primaryColour},&H000000FF,${s.outlineColour},${s.backColour},1,0,0,0,100,100,0,0,1,${outline},${s.shadow},2,60,60,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  const events = cues.map((c) => {
    const text = c.text.replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '')
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Alma,,0,0,0,,${text}`
  })

  return [...header, ...events, ''].join('\n')
}
