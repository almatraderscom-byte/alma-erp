/**
 * CS11 — deterministic video QC + error sanitization.
 *
 * ffmpeg/ffprobe do the heavy lifting (no LLM): duration validity, black
 * frames, frozen frames, abrupt/frozen endings, loudness measurement. A
 * narrow mechanical Gemini check compares sampled frames to the approved
 * reference still (same person/garment) — fail-open, never blocks on a dead
 * vision API. Mirrors src/lib/creative-studio/video-recipes.ts constants
 * (keep in sync).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'

const execFileAsync = promisify(execFile)

export const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1:LRA=11'

// Mirror of VIDEO_ERRORS_BN in src/lib/creative-studio/video-recipes.ts.
export const VIDEO_ERRORS_BN = {
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

/**
 * Raw error → safe Bangla message for the owner; the RAW text goes to the
 * worker log only (admin diagnostics). Deterministic — mirror of
 * sanitizeVideoErrorMessage in video-recipes.ts.
 */
export function sanitizeVideoError(err, context = 'video') {
  const raw = err?.message ?? String(err)
  console.error(`[video-qc] RAW ${context} error (admin): ${raw}`)
  const s = raw.toLowerCase()
  if (s.includes('timed out') && s.includes('veo')) return VIDEO_ERRORS_BN.VEO_TIMEOUT
  if (s.includes('veo download')) return VIDEO_ERRORS_BN.VEO_DOWNLOAD
  if (s.includes('veo')) return VIDEO_ERRORS_BN.VEO_FAILED
  if (s.includes('qc_black')) return VIDEO_ERRORS_BN.QC_BLACK
  if (s.includes('qc_frozen')) return VIDEO_ERRORS_BN.QC_FROZEN
  if (s.includes('qc_duration')) return VIDEO_ERRORS_BN.QC_DURATION
  if (s.includes('download failed')) return VIDEO_ERRORS_BN.SOURCE_DOWNLOAD
  if (s.includes('ffmpeg') || s.includes('ffprobe') || s.includes('/tmp/') || s.includes('spawn')) {
    return VIDEO_ERRORS_BN.FFMPEG_RENDER
  }
  return VIDEO_ERRORS_BN.UNKNOWN
}

export async function probeBasics(file) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  )
  const info = JSON.parse(stdout)
  const video = (info.streams ?? []).find((s) => s.codec_type === 'video')
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio')
  return {
    durationSec: Number(info.format?.duration ?? 0),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
  }
}

function parseSpans(stderr, startRe, durRe) {
  const spans = []
  let m
  const startMatches = [...stderr.matchAll(startRe)]
  const durMatches = [...stderr.matchAll(durRe)]
  for (let i = 0; i < startMatches.length; i++) {
    const start = Number(startMatches[i][1])
    const dur = Number(durMatches[i]?.[1] ?? 0)
    if (Number.isFinite(start)) spans.push({ start, duration: dur })
  }
  void m
  return spans
}

/** blackdetect + freezedetect in one pass; parses filter logs from stderr. */
export async function detectBlackFrozen(file) {
  const { stderr } = await execFileAsync(
    'ffmpeg',
    [
      '-i', file,
      '-vf', 'blackdetect=d=0.4:pic_th=0.96,freezedetect=n=-60dB:d=1.0',
      '-an', '-f', 'null', '-',
    ],
    { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
  ).catch((e) => ({ stderr: e.stderr ?? '' })) // filters log to stderr even on rc=0
  const black = parseSpans(
    stderr,
    /black_start:\s*([\d.]+)/g,
    /black_duration:\s*([\d.]+)/g,
  )
  const frozenStarts = [...stderr.matchAll(/lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const frozenDurs = [...stderr.matchAll(/lavfi\.freezedetect\.freeze_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const frozen = frozenStarts.map((start, i) => ({ start, duration: frozenDurs[i] ?? 0 }))
  return { black, frozen }
}

/** loudnorm measurement pass (JSON on stderr). Null when no audio/failure. */
export async function measureLoudness(file) {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      ['-i', file, '-af', `${LOUDNORM_FILTER}:print_format=json`, '-f', 'null', '-'],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    ).catch((e) => ({ stderr: e.stderr ?? '' }))
    const json = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/)?.[0]
    if (!json) return null
    const parsed = JSON.parse(json)
    return { inputI: Number(parsed.input_i), inputTp: Number(parsed.input_tp) }
  } catch {
    return null
  }
}

/** Extract a frame at `sec` to a JPEG buffer (for reference comparison). */
async function frameAt(file, sec) {
  const out = join(tmpdir(), `vqc-${randomUUID().slice(0, 8)}.jpg`)
  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', out],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    )
    const buf = readFileSync(out)
    return buf
  } finally {
    try { unlinkSync(out) } catch { /* ignore */ }
  }
}

/**
 * CS11 — narrow mechanical reference check: do sampled frames still show the
 * SAME person and the SAME garment as the approved still? Fail-open null.
 */
export async function compareFramesToReference({ file, referenceBuf, durationSec }) {
  const key = process.env.GEMINI_API_KEY
  if (!key || !referenceBuf) return null
  try {
    const stamps = [0.2, Math.max(0.5, durationSec / 2), Math.max(1, durationSec - 0.6)]
    const frames = []
    for (const s of stamps) {
      try { frames.push(await frameAt(file, s)) } catch { /* skip */ }
    }
    if (!frames.length) return null
    const parts = [
      {
        text: 'Image 1 is the APPROVED reference photo. The following frames are sampled from a generated video of it. STRICT JSON only: {"samePerson": bool, "sameGarment": bool, "grossDrift": bool (body/garment visibly morphing or wrong)}',
      },
      { inline_data: { mime_type: 'image/jpeg', data: referenceBuf.toString('base64') } },
      ...frames.map((f) => ({ inline_data: { mime_type: 'image/jpeg', data: f.toString('base64') } })),
    ]
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, maxOutputTokens: 64 } }),
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!res.ok) return null
    const data = await res.json()
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
    return {
      samePerson: parsed.samePerson !== false,
      sameGarment: parsed.sameGarment !== false,
      grossDrift: parsed.grossDrift === true,
      framesChecked: frames.length,
    }
  } catch {
    return null
  }
}

/**
 * Full deterministic gate for a finished video file.
 * critical → the artifact must NOT be accepted (caller retries or fails).
 */
export async function runVideoQc({ file, expectedDurationSec, referenceBuf }) {
  const critical = []
  const warnings = []

  const basics = await probeBasics(file)
  if (!basics.hasVideo) critical.push('QC_DURATION: no video stream')
  const dur = basics.durationSec
  if (expectedDurationSec && (dur < Math.min(2, expectedDurationSec * 0.5) || dur < expectedDurationSec * 0.6)) {
    critical.push(`QC_DURATION: got ${dur.toFixed(1)}s, expected ~${expectedDurationSec}s`)
  }

  const { black, frozen } = await detectBlackFrozen(file)
  const blackTotal = black.reduce((s, b) => s + b.duration, 0)
  const frozenTotal = frozen.reduce((s, f) => s + f.duration, 0)
  if (dur > 0 && blackTotal / dur > 0.2) critical.push(`QC_BLACK: ${(blackTotal / dur * 100).toFixed(0)}% black`)
  if (black.some((b) => b.start < 0.3 && b.duration > 0.8)) critical.push('QC_BLACK: opens on black')
  if (dur > 0 && frozenTotal / dur > 0.4) critical.push(`QC_FROZEN: ${(frozenTotal / dur * 100).toFixed(0)}% frozen`)
  if (frozen.some((f) => f.start > dur - 1.6 && f.duration > 1.2)) warnings.push('frozen_ending')
  if (black.some((b) => b.start > dur - 1.2)) warnings.push('black_ending')

  const loudness = basics.hasAudio ? await measureLoudness(file) : null

  let referenceCheck = null
  if (referenceBuf) {
    referenceCheck = await compareFramesToReference({ file, referenceBuf, durationSec: dur })
    if (referenceCheck?.grossDrift) warnings.push('reference_drift')
  }

  return {
    pass: critical.length === 0,
    critical,
    warnings,
    metrics: {
      durationSec: Math.round(dur * 10) / 10,
      blackSec: Math.round(blackTotal * 10) / 10,
      frozenSec: Math.round(frozenTotal * 10) / 10,
      loudness,
      width: basics.width,
      height: basics.height,
      hasAudio: basics.hasAudio,
    },
    referenceCheck,
  }
}
