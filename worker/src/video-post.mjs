/**
 * Phase V2 — caption + audio layer for video_edit reels. Pure ffmpeg mechanics:
 *
 *   captions   — reel speech → app's /internal/video-captions (Whisper, twice-
 *                checked Bangla) → .ass burned with the bundled Noto Sans Bengali
 *   music bed  — owner-approved track only, looped/trimmed, faded out; ducks
 *                under speech/voiceover via sidechaincompress
 *   voiceover  — owner-typed line rendered by the existing Google Bangla TTS
 *                (never LLM-written); replaces the shoot audio
 *   stings     — logo intro/outro pre-rendered ONCE per aspect (cached in
 *                storage) and concat-copied around the reel, no per-run render
 *   covers     — 4 candidate cover frames for the Gallery picker
 *
 * One video re-encode at most (captions burn); audio-only changes keep -c:v copy.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAppUrl, getInternalToken } from './env.mjs'

const execFileAsync = promisify(execFile)

const RENDER_TIMEOUT_MS = 15 * 60_000
const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')

const STING_INTRO_SEC = 1.2
const STING_OUTRO_SEC = 1.6
const MUSIC_VOLUME = 0.55

const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1:LRA=11' // CS11 — mirror of video-recipes.ts

async function ffprobeJson(file) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  )
  return JSON.parse(stdout)
}

async function hasAudioStream(file) {
  const info = await ffprobeJson(file)
  return (info.streams ?? []).some((s) => s.codec_type === 'audio')
}

async function mediaDuration(file) {
  const info = await ffprobeJson(file)
  return Number(info.format?.duration ?? 0)
}

/** Download a storage object to a local file (small files — music, logo). */
async function downloadSmall(supabase, storagePath, destFile) {
  const { data, error } = await supabase.storage.from('agent-files').download(storagePath)
  if (error || !data) throw new Error(`download failed for ${storagePath}: ${error?.message}`)
  await writeFile(destFile, Buffer.from(await data.arrayBuffer()))
  return destFile
}

/**
 * Fetch burned-caption ASS content from the app. `knownText` short-circuits the
 * accuracy pass when the words are already exact (owner-typed voiceover).
 */
async function fetchCaptions({ audioFile, output, knownText }) {
  const audio = await readFile(audioFile)
  const params = new URLSearchParams({ width: String(output.width), height: String(output.height) })
  if (knownText) params.set('text', knownText)
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/video-captions?${params}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/mpeg',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: audio,
    signal: AbortSignal.timeout(90_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`captions endpoint failed: ${body?.error ?? `HTTP ${res.status}`}`)
  return { ass: body.ass ?? null, cues: Array.isArray(body.cues) ? body.cues : [] }
}

/** Extract the reel's speech as a small mp3 for Whisper. */
async function extractSpeechMp3(srcFile, destFile) {
  await execFileAsync(
    'ffmpeg',
    ['-y', '-i', srcFile, '-vn', '-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', destFile],
    { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  )
  return destFile
}

const fmt = (label) => `${label}aformat=sample_rates=48000:channel_layouts=stereo`

/**
 * The single post-render pass: burns captions (if any) and rebuilds the
 * soundtrack per audioMode/voiceover. Audio-only changes keep -c:v copy.
 */
async function renderPostPass({ workDir, reelFile, outFile, assFile, captionOverlays, marginV, musicFile, voiceFile, audioMode, reelHasAudio, durationSec }) {
  const args = ['-y', '-i', reelFile]
  const inputs = { music: -1, voice: -1, overlayStart: -1 }
  let idx = 1
  if (musicFile) { args.push('-i', musicFile); inputs.music = idx++ }
  if (voiceFile) { args.push('-i', voiceFile); inputs.voice = idx++ }
  if (captionOverlays?.length) {
    inputs.overlayStart = idx
    for (const ov of captionOverlays) {
      args.push('-loop', '1', '-i', ov.file)
      idx++
    }
  }

  const parts = []
  const fadeStart = Math.max(0, durationSec - 1)

  // ── audio graph → [aout] (null when the original track stays untouched) ──
  let aout = null
  const speechLabel = voiceFile ? `[${inputs.voice}:a]` : reelHasAudio ? '[0:a]' : null

  if (musicFile) {
    parts.push(`[${inputs.music}:a]aloop=loop=-1:size=2e9,atrim=0:${durationSec},${fmt('')},volume=${MUSIC_VOLUME}[mus]`)
    if (speechLabel && (audioMode === 'music_duck' || voiceFile)) {
      parts.push(`${speechLabel}${fmt('')},asplit=2[sp1][sp2]`)
      parts.push(`[mus][sp1]sidechaincompress=threshold=0.03:ratio=12:attack=25:release=500[musduck]`)
      parts.push(`[sp2][musduck]amix=inputs=2:duration=first:dropout_transition=0,afade=t=out:st=${fadeStart}:d=1,${LOUDNORM_FILTER}[aout]`)
    } else {
      parts.push(`[mus]afade=t=out:st=${fadeStart}:d=1,atrim=0:${durationSec},${LOUDNORM_FILTER}[aout]`)
    }
    aout = '[aout]'
  } else if (voiceFile) {
    parts.push(`[${inputs.voice}:a]${fmt('')},${LOUDNORM_FILTER}[aout]`)
    aout = '[aout]'
  }

  // ── video: caption overlays (pango-shaped PNGs), ASS fallback, or copy ───
  let videoArgs
  if (captionOverlays?.length) {
    let vTail = '[0:v]'
    captionOverlays.forEach((ov, i) => {
      const inIdx = inputs.overlayStart + i
      const outLabel = i === captionOverlays.length - 1 ? '[vout]' : `[vcap${i}]`
      parts.push(
        `${vTail}[${inIdx}:v]overlay=0:H-h-${marginV}:enable='between(t,${ov.start},${ov.end})'${outLabel}`,
      )
      vTail = outLabel
    })
    videoArgs = ['-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22']
  } else if (assFile) {
    const assName = assFile.replace(/\\/g, '/').split('/').pop()
    parts.push(`[0:v]subtitles=filename=${assName}:fontsdir='${FONTS_DIR}'[vout]`)
    videoArgs = ['-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22']
  } else {
    videoArgs = ['-map', '0:v', '-c:v', 'copy']
  }

  args.push(...videoArgs)
  if (aout) {
    args.push('-map', aout, '-c:a', 'aac', '-b:a', '128k')
  } else if (reelHasAudio) {
    // CS11 — even untouched original audio ships at the social loudness target
    parts.push(`[0:a]${LOUDNORM_FILTER}[anorm]`)
    args.push('-map', '[anorm]', '-c:a', 'aac', '-b:a', '128k')
  }
  if (parts.length > 0) args.splice(args.indexOf(videoArgs[0]), 0, '-filter_complex', parts.join(';'))
  args.push('-movflags', '+faststart', '-t', String(durationSec + 0.5), outFile)

  // subtitles filter resolves relative filenames against cwd → run in workDir
  await execFileAsync('ffmpeg', args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, cwd: workDir })
}

/**
 * Logo intro/outro stings — generated ONCE per aspect + logo version with the
 * reel's exact encode params, cached in storage, then concat-COPIED (roadmap:
 * "pre-rendered clips concatenated, no per-run rendering").
 */
async function ensureStings(supabase, { brandLogoPath, output, workDir }) {
  const key = `${output.width}x${output.height}`
  const metaKey = `studio_sting_meta:${key}`
  const introPath = `studio-video/stings/${key}-intro.mp4`
  const outroPath = `studio-video/stings/${key}-outro.mp4`
  const introFile = join(workDir, 'sting-intro.mp4')
  const outroFile = join(workDir, 'sting-outro.mp4')

  // cache hit only if the same logo version produced them
  try {
    const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', metaKey).maybeSingle()
    if (data?.value === brandLogoPath) {
      await downloadSmall(supabase, introPath, introFile)
      await downloadSmall(supabase, outroPath, outroFile)
      return { introFile, outroFile }
    }
  } catch { /* regenerate below */ }

  const logoFile = join(workDir, 'brand-logo.png')
  await downloadSmall(supabase, brandLogoPath, logoFile)

  const logoW = Math.round(output.width * 0.5)
  const common = [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart',
  ]
  const bg = (dur) => `color=c=0x141019:size=${output.width}x${output.height}:rate=30:duration=${dur}`

  // intro: logo fades in over the dark brand backdrop
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', bg(STING_INTRO_SEC),
    '-i', logoFile,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${STING_INTRO_SEC}`,
    '-filter_complex',
    `[1:v]scale=${logoW}:-1[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2,fade=t=in:st=0:d=0.5[vout]`,
    '-map', '[vout]', '-map', '2:a', '-t', String(STING_INTRO_SEC), ...common, introFile,
  ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })

  // outro: logo holds then fades to black
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', bg(STING_OUTRO_SEC),
    '-i', logoFile,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${STING_OUTRO_SEC}`,
    '-filter_complex',
    `[1:v]scale=${logoW}:-1[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2,fade=t=out:st=${STING_OUTRO_SEC - 0.6}:d=0.6[vout]`,
    '-map', '[vout]', '-map', '2:a', '-t', String(STING_OUTRO_SEC), ...common, outroFile,
  ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })

  // cache for next runs (best-effort)
  try {
    await supabase.storage.from('agent-files').upload(introPath, await readFile(introFile), { contentType: 'video/mp4', upsert: true })
    await supabase.storage.from('agent-files').upload(outroPath, await readFile(outroFile), { contentType: 'video/mp4', upsert: true })
    await supabase.from('agent_kv_settings').upsert({ key: metaKey, value: brandLogoPath }, { onConflict: 'key' })
  } catch (err) {
    console.warn('[worker] sting cache write failed:', err?.message)
  }
  return { introFile, outroFile }
}

/** concat-copy intro + reel + outro (identical encode params — no re-render). */
async function concatStings({ workDir, introFile, reelFile, outroFile, outFile }) {
  const listFile = join(workDir, 'concat.txt')
  const esc = (p) => p.replace(/'/g, "'\\''")
  await writeFile(listFile, [introFile, reelFile, outroFile].map((f) => `file '${esc(f)}'`).join('\n'))
  await execFileAsync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outFile],
    { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  )
}

/**
 * V4 — stitch 2–3 finished Veo clips into one long reel with crossfades.
 * Pure ffmpeg; clips come from the same aspect so only fps/format normalize.
 */
export async function processVeoConcat(job, { supabase, callJobResult, reportProgress }) {
  const { pendingActionId, payload } = job.data
  const { concatPaths = [], fadeSec = 0.4 } = payload
  if (concatPaths.length < 2) {
    await callJobResult(pendingActionId, 'failed', undefined, 'veoConcat needs >=2 clips')
    return
  }
  const { mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const workDir = join(tmpdir(), `alma-veo-concat-${pendingActionId}`)
  await mkdir(workDir, { recursive: true })
  try {
    await reportProgress(supabase, pendingActionId, 1)
    const files = []
    for (let i = 0; i < concatPaths.length; i++) {
      files.push(await downloadSmall(supabase, concatPaths[i], join(workDir, `clip-${i}.mp4`)))
    }
    await reportProgress(supabase, pendingActionId, 4)
    const lens = []
    const hasA = []
    for (const f of files) {
      lens.push(await mediaDuration(f))
      hasA.push(await hasAudioStream(f))
    }
    const parts = []
    files.forEach((_, i) => {
      parts.push(`[${i}:v]fps=30,setsar=1,format=yuv420p[v${i}]`)
      // a clip without audio (e.g. an old silent reel) gets a silent bed so
      // acrossfade always has two real inputs
      parts.push(
        hasA[i]
          ? `[${i}:a]${fmt('')}[a${i}]`
          : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${lens[i]}[a${i}]`,
      )
    })
    let vT = '[v0]'
    let aT = '[a0]'
    let outLen = lens[0]
    for (let i = 1; i < files.length; i++) {
      const off = Math.round((outLen - fadeSec) * 100) / 100
      const vO = i === files.length - 1 ? '[vout]' : `[vx${i}]`
      const aO = i === files.length - 1 ? '[aout]' : `[ax${i}]`
      parts.push(`${vT}[v${i}]xfade=transition=fade:duration=${fadeSec}:offset=${off}${vO}`)
      parts.push(`${aT}[a${i}]acrossfade=d=${fadeSec}${aO}`)
      vT = vO; aT = aO
      outLen = outLen + lens[i] - fadeSec
    }
    const outFile = join(workDir, 'reel.mp4')
    await execFileAsync('ffmpeg', [
      '-y', ...files.flatMap((f) => ['-i', f]),
      '-filter_complex', parts.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile,
    ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })

    const thumbFile = join(workDir, 'thumb.jpg')
    await execFileAsync('ffmpeg', ['-y', '-ss', '0.5', '-i', outFile, '-frames:v', '1', '-vf', 'scale=480:-2', thumbFile], { timeout: 60_000 }).catch(() => {})

    const storagePath = `generated/${pendingActionId}.mp4`
    const { readFile: rf } = await import('node:fs/promises')
    const { error: upErr } = await supabase.storage.from('agent-files').upload(storagePath, await rf(outFile), { contentType: 'video/mp4', upsert: true })
    if (upErr) throw new Error(upErr.message)
    let thumbPath = null
    try {
      thumbPath = `generated/${pendingActionId}-thumb.jpg`
      await supabase.storage.from('agent-files').upload(thumbPath, await rf(thumbFile), { contentType: 'image/jpeg', upsert: true })
    } catch { thumbPath = null }

    await callJobResult(pendingActionId, 'success', {
      storagePath,
      ...(thumbPath ? { thumbPath } : {}),
      mediaType: 'video',
      durationSec: Math.round(outLen * 10) / 10,
      clips: files.length,
      aspect: payload.aspect ?? '9:16',
    })
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * V4 AI-assist (per-run opt-in): Gemini watches a small proxy of the shoot and
 * suggests highlight timestamps. They are only ADDED to scdet's cut list —
 * the deterministic planner still makes every decision.
 */
export async function suggestHighlights({ inputFile, durationSec }) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return []
  const proxyFile = inputFile.replace(/\.mp4$/, '-proxy.mp4')
  await execFileAsync('ffmpeg', ['-y', '-i', inputFile, '-vf', 'scale=320:-2,fps=5', '-an', '-c:v', 'libx264', '-crf', '32', proxyFile], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
  const { GoogleGenAI } = await import('@google/genai')
  const genai = new GoogleGenAI({ apiKey: key })
  let file = await genai.files.upload({ file: proxyFile, config: { mimeType: 'video/mp4' } })
  const start = Date.now()
  while (file.state === 'PROCESSING' && Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 4000))
    file = await genai.files.get({ name: file.name })
  }
  if (file.state !== 'ACTIVE') return []
  const res = await genai.models.generateContent({
    model: 'gemini-3.1-flash',
    contents: [{
      role: 'user',
      parts: [
        { fileData: { fileUri: file.uri, mimeType: 'video/mp4' } },
        { text: `This is a ${Math.round(durationSec)}s product/fashion shoot. List up to 8 timestamps (seconds, one number per line, nothing else) where visually strong moments START.` },
      ],
    }],
  })
  const text = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return String(text)
    .split(/\s+/)
    .map((t) => Number(t.replace(/[^0-9.]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0.5 && n < durationSec - 0.5)
    .slice(0, 8)
}

/** 4 candidate cover frames for the Gallery picker. */
export async function extractCoverCandidates({ file, workDir, durationSec }) {
  const stamps = [0.12, 0.38, 0.62, 0.88].map((p) => Math.max(0.2, p * durationSec))
  const files = []
  for (let i = 0; i < stamps.length; i++) {
    const out = join(workDir, `cover-${i + 1}.jpg`)
    try {
      await execFileAsync(
        'ffmpeg',
        ['-y', '-ss', String(stamps[i]), '-i', file, '-frames:v', '1', '-vf', 'scale=540:-2', out],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      )
      await stat(out)
      files.push(out)
    } catch { /* skip frame */ }
  }
  // CS11 — deterministic default ordering: sharp, well-exposed frames first
  // (mirror of scoreCoverOrder in video-recipes.ts). Manual override in the
  // Gallery cover picker always wins; this only sets the default.
  try {
    const sharp = (await import('sharp')).default
    const metrics = []
    for (let i = 0; i < files.length; i++) {
      const st = await sharp(files[i]).grayscale().stats()
      metrics.push({ index: i, sharpness: st.channels[0].stdev, brightness: st.channels[0].mean })
    }
    const maxSharp = Math.max(1, ...metrics.map((m) => m.sharpness))
    const order = metrics
      .map((m) => ({
        index: m.index,
        score: m.sharpness / maxSharp - (m.brightness < 40 || m.brightness > 215 ? 0.5 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .map((m) => m.index)
    return order.map((i) => files[i])
  } catch (err) {
    console.warn('[video-post] cover scoring skipped:', err.message)
    return files
  }
}

/**
 * Apply the whole V2 layer to a rendered reel. Returns the final file plus
 * flags for the job result. Caption/audio failures degrade gracefully — a
 * reel without captions beats a dead job — but a requested-and-failed layer
 * is reported in `warnings`.
 */
export async function applyPostLayers({ supabase, workDir, reelFile, payload, output }) {
  const { captions, audioMode = 'original', musicPath, voiceoverText, stings, brandLogoPath } = payload
  const wantsAudioWork = (audioMode !== 'original' && musicPath) || voiceoverText
  const warnings = []
  let current = reelFile
  const durationSec = await mediaDuration(current)
  const reelHasAudio = await hasAudioStream(current)

  // voiceover TTS (existing Google Bangla voice — owner's exact words)
  let voiceFile = null
  if (voiceoverText) {
    try {
      const { synthesizeSpeech } = await import('./tts.mjs')
      const mp3 = await synthesizeSpeech(voiceoverText, 400, { purpose: 'studio_voiceover' })
      voiceFile = join(workDir, 'voiceover.mp3')
      await writeFile(voiceFile, mp3)
    } catch (err) {
      warnings.push(`voiceover_failed:${err.message?.slice(0, 80)}`)
    }
  }

  // captions — transcribe the SPEECH source, not the mixed track. Preferred
  // renderer: pango-shaped PNG overlays (VPS libass breaks Bangla shaping);
  // ASS burn-in stays as the fallback.
  let assFile = null
  let captionOverlays = []
  let marginV = 0
  if (captions) {
    try {
      const speechSrc = voiceFile ?? (reelHasAudio ? await extractSpeechMp3(current, join(workDir, 'speech.mp3')) : null)
      if (speechSrc) {
        const got = await fetchCaptions({
          audioFile: speechSrc,
          output,
          knownText: voiceFile ? voiceoverText : undefined,
        })
        if (got.cues.length > 0) {
          try {
            const { renderCaptionOverlays, captionMarginV } = await import('./video-captions-overlay.mjs')
            captionOverlays = await renderCaptionOverlays({ cues: got.cues, output, workDir })
            marginV = captionMarginV(output)
          } catch (err) {
            console.warn('[worker] caption overlay render failed, falling back to ASS:', err?.message)
            captionOverlays = []
          }
        }
        if (captionOverlays.length === 0 && got.ass) {
          assFile = join(workDir, 'captions.ass')
          await writeFile(assFile, got.ass, 'utf8')
        }
      } else {
        warnings.push('captions_skipped:no_speech_track')
      }
    } catch (err) {
      warnings.push(`captions_failed:${err.message?.slice(0, 80)}`)
    }
  }

  // music bed
  let musicFile = null
  if (audioMode !== 'original' && musicPath) {
    try {
      musicFile = await downloadSmall(supabase, musicPath, join(workDir, 'music-bed'))
    } catch (err) {
      warnings.push(`music_failed:${err.message?.slice(0, 80)}`)
      musicFile = null
    }
  }

  if (assFile || captionOverlays.length || musicFile || voiceFile) {
    const mixed = join(workDir, 'reel-post.mp4')
    await renderPostPass({
      workDir,
      reelFile: current,
      outFile: mixed,
      assFile,
      captionOverlays,
      marginV,
      musicFile,
      voiceFile,
      audioMode,
      reelHasAudio,
      durationSec,
    })
    current = mixed
  } else if (wantsAudioWork || captions) {
    // requested layers all failed — reel ships as-is, warnings tell the story
  }

  // logo stings (concat-copy; needs the reel to carry an audio track)
  if (stings && brandLogoPath) {
    try {
      let reelForConcat = current
      if (!(await hasAudioStream(current))) {
        const withAudio = join(workDir, 'reel-silent-audio.mp4')
        await execFileAsync('ffmpeg', [
          '-y', '-i', current,
          '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
          '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
          '-shortest', '-movflags', '+faststart', withAudio,
        ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
        reelForConcat = withAudio
      }
      const { introFile, outroFile } = await ensureStings(supabase, { brandLogoPath, output, workDir })
      const withStings = join(workDir, 'reel-stings.mp4')
      await concatStings({ workDir, introFile, reelFile: reelForConcat, outroFile, outFile: withStings })
      current = withStings
    } catch (err) {
      warnings.push(`stings_failed:${err.message?.slice(0, 80)}`)
    }
  }

  return {
    finalFile: current,
    warnings,
    applied: {
      captions: Boolean(assFile) || captionOverlays.length > 0,
      captionRenderer: captionOverlays.length > 0 ? 'pango_overlay' : assFile ? 'libass' : null,
      music: Boolean(musicFile),
      voiceover: Boolean(voiceFile),
      stings: current.includes('reel-stings'),
    },
  }
}
