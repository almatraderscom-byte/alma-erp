/**
 * Phase V1 — deterministic video Recipe Engine, worker side.
 *
 * The owner's phone-shot original is already in Supabase (signed direct
 * upload). This pipeline is pure ffmpeg on the VPS — ZERO LLM calls:
 *
 *   download → probe → scene detect (scdet, cached per source) →
 *   cut plan (fetched from the app's unit-tested pure planner) →
 *   cut + concat/crossfade + crop + H.264/SDR encode → thumbnail → upload
 *
 * Progress is written into the pending-action payload (ধাপ N/M) so the studio
 * job tracker shows the assembly line exactly like the family chain.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getAppUrl, getInternalToken } from './env.mjs'

const execFileAsync = promisify(execFile)

const SCENE_THRESHOLD = 0.3
const SCENE_CACHE_PREFIX = 'studio_video_scenes:v1:'
const PROBE_TIMEOUT_MS = 60_000
const SCDET_TIMEOUT_MS = 5 * 60_000
const RENDER_TIMEOUT_MS = 20 * 60_000

const STEPS_BN = [
  'ভিডিও ডাউনলোড হচ্ছে',
  'ভিডিও বিশ্লেষণ হচ্ছে',
  'কাট প্ল্যান হচ্ছে',
  'রিল রেন্ডার হচ্ছে',
  'ক্যাপশন/অডিও বসছে',
  'আপলোড হচ্ছে',
]

async function ensureFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 15_000 })
    await execFileAsync('ffprobe', ['-version'], { timeout: 15_000 })
  } catch {
    throw new Error('ffmpeg_missing_on_vps — apt-get install ffmpeg needed')
  }
}

/** Write ধাপ N/M into the pending-action payload (best-effort; UI polls it). */
async function reportProgress(supabase, pendingActionId, step) {
  try {
    const { data } = await supabase
      .from('agent_pending_actions')
      .select('payload')
      .eq('id', pendingActionId)
      .maybeSingle()
    const payload = data?.payload ?? {}
    await supabase
      .from('agent_pending_actions')
      .update({
        payload: {
          ...payload,
          _videoProgress: { step, total: STEPS_BN.length, labelBn: STEPS_BN[step - 1] ?? '' },
        },
      })
      .eq('id', pendingActionId)
  } catch (err) {
    console.warn(`[worker] video-edit ${pendingActionId} progress write failed:`, err?.message)
  }
}

/** Stream a big storage object to disk (a 500 MB original must never become a Buffer). */
async function downloadToFile(supabase, storagePath, destFile) {
  const { data, error } = await supabase.storage
    .from('agent-files')
    .createSignedUrl(storagePath, 3600)
  if (error || !data?.signedUrl) {
    throw new Error(`source video signed URL failed: ${error?.message ?? 'no URL'}`)
  }
  const res = await fetch(data.signedUrl)
  if (!res.ok || !res.body) throw new Error(`source video download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destFile))
}

async function probeVideo(inputFile) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputFile],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  )
  const info = JSON.parse(stdout)
  const video = (info.streams ?? []).find((s) => s.codec_type === 'video')
  if (!video) throw new Error('no video stream in uploaded file')
  const durationSec = Number(info.format?.duration ?? video.duration ?? 0)
  if (!Number.isFinite(durationSec) || durationSec <= 0.5) throw new Error('could not read video duration')
  const hasAudio = (info.streams ?? []).some((s) => s.codec_type === 'audio')
  // iPhone HDR shoots: HLG (arib-std-b67) or PQ (smpte2084) — must tonemap to
  // SDR or every filtered frame shifts colour (roadmap gotcha).
  const isHdr = ['smpte2084', 'arib-std-b67'].includes(String(video.color_transfer ?? '').toLowerCase())
  return { durationSec, hasAudio, isHdr }
}

/** ffmpeg scene-change detection at 320px — deterministic, cached per source path. */
async function detectScenes(supabase, storagePath, inputFile) {
  const cacheKey = `${SCENE_CACHE_PREFIX}${storagePath}`
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', cacheKey)
      .maybeSingle()
    if (data?.value) {
      const cached = JSON.parse(data.value)
      if (Array.isArray(cached)) return cached
    }
  } catch { /* cache miss path below */ }

  // showinfo prints the selected (scene-change) frames to stderr
  let stderr = ''
  try {
    const run = await execFileAsync(
      'ffmpeg',
      [
        '-i', inputFile,
        '-vf', `scale=320:-2:flags=fast_bilinear,select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
        '-an', '-f', 'null', '-',
      ],
      { timeout: SCDET_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    )
    stderr = run.stderr ?? ''
  } catch (err) {
    // a non-zero exit can still carry usable showinfo output
    stderr = err?.stderr ?? ''
    if (!stderr) throw err
  }

  const scenes = []
  for (const match of String(stderr).matchAll(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    scenes.push(Number(match[1]))
  }
  const unique = Array.from(new Set(scenes)).sort((a, b) => a - b)

  try {
    await supabase
      .from('agent_kv_settings')
      .upsert({ key: cacheKey, value: JSON.stringify(unique) }, { onConflict: 'key' })
  } catch { /* cache is an optimization only */ }
  return unique
}

/** Ask the app's unit-tested pure planner for the cut plan (single source of truth). */
async function fetchCutPlan({ recipeId, durationSec, sceneChanges, targetSec, aspect }) {
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/video-cut-plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: JSON.stringify({ recipeId, durationSec, sceneChanges, targetSec, aspect }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.plan) {
    throw new Error(`cut plan failed: ${body?.error ?? `HTTP ${res.status}`}`)
  }
  return body
}

const TONEMAP_CHAIN = 'zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv'

/**
 * Build the -filter_complex graph: per-segment trim → concat (hard cuts) or
 * xfade/acrossfade chain (crossfade recipes) → tonemap (HDR) → center-crop to
 * the target aspect → scale → SDR yuv420p.
 */
function buildFilterGraph({ segments, transition, fadeSec, hasAudio, width, height, fps, tonemap }) {
  const parts = []
  const n = segments.length

  segments.forEach((seg, i) => {
    parts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS,fps=${fps}[v${i}]`)
    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`)
    }
  })

  let vTail
  let aTail = null
  if (n === 1) {
    vTail = '[v0]'
    aTail = hasAudio ? '[a0]' : null
  } else if (transition === 'crossfade' && fadeSec > 0) {
    // xfade needs a running offset: output length so far minus the fade.
    let outLen = segments[0].end - segments[0].start
    vTail = '[v0]'
    aTail = hasAudio ? '[a0]' : null
    for (let i = 1; i < n; i++) {
      const segLen = segments[i].end - segments[i].start
      const offset = Math.max(0, Math.round((outLen - fadeSec) * 100) / 100)
      const vOut = i === n - 1 ? '[vjoin]' : `[vx${i}]`
      parts.push(`${vTail}[v${i}]xfade=transition=fade:duration=${fadeSec}:offset=${offset}${vOut}`)
      vTail = vOut
      if (hasAudio) {
        const aOut = i === n - 1 ? '[ajoin]' : `[ax${i}]`
        parts.push(`${aTail}[a${i}]acrossfade=d=${fadeSec}${aOut}`)
        aTail = aOut
      }
      outLen = outLen + segLen - fadeSec
    }
  } else {
    const vIns = segments.map((_, i) => `[v${i}]`).join('')
    if (hasAudio) {
      const ins = segments.map((_, i) => `[v${i}][a${i}]`).join('')
      parts.push(`${ins}concat=n=${n}:v=1:a=1[vjoin][ajoin]`)
      aTail = '[ajoin]'
    } else {
      parts.push(`${vIns}concat=n=${n}:v=1:a=0[vjoin]`)
    }
    vTail = '[vjoin]'
  }

  const post = [
    ...(tonemap ? [TONEMAP_CHAIN] : []),
    `crop=w='min(iw,ih*${width}/${height})':h='min(ih,iw*${height}/${width})'`,
    `scale=${width}:${height}`,
    'setsar=1',
    'format=yuv420p',
  ].join(',')
  parts.push(`${vTail}${post}[vout]`)

  return { graph: parts.join(';'), audioLabel: aTail }
}

async function renderOutput({ inputFile, outFile, plan, output, hasAudio, isHdr }) {
  const attempt = async (tonemap) => {
    const { graph, audioLabel } = buildFilterGraph({
      segments: plan.segments,
      transition: plan.transition,
      fadeSec: plan.fadeSec,
      hasAudio,
      width: output.width,
      height: output.height,
      fps: output.fps,
      tonemap,
    })
    const args = [
      '-y', '-i', inputFile,
      '-filter_complex', graph,
      '-map', '[vout]',
      ...(audioLabel ? ['-map', audioLabel, '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-movflags', '+faststart',
      outFile,
    ]
    await execFileAsync('ffmpeg', args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })
  }

  try {
    await attempt(isHdr)
  } catch (err) {
    // Some ffmpeg builds ship without zimg — fall back to plain SDR conversion
    // rather than failing the whole reel (colours slightly washed vs broken job).
    if (isHdr) {
      console.warn('[worker] video-edit tonemap failed, retrying without:', err?.message?.slice(0, 200))
      await attempt(false)
    } else {
      throw err
    }
  }
}

const CROP_SIZES = {
  '9:16': [1080, 1920],
  '4:5': [1080, 1350],
  '1:1': [1080, 1080],
  '16:9': [1920, 1080],
}

const srtTime = (seconds) => {
  const millis = Math.max(0, Math.round(Number(seconds) * 1000))
  const hh = Math.floor(millis / 3_600_000)
  const mm = Math.floor((millis % 3_600_000) / 60_000)
  const ss = Math.floor((millis % 60_000) / 1000)
  const ms = millis % 1000
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function buildCaptionSrt(contract) {
  return (contract.transcript ?? [])
    .filter((cue) => cue.track === 'caption' && cue.text)
    .map((cue, index) => [
      index + 1,
      `${srtTime(cue.startSec)} --> ${srtTime(cue.endSec)}`,
      String(cue.text).replace(/\r?\n/g, ' ').trim(),
      '',
    ].join('\n'))
    .join('\n')
}

const escapeSubtitlePath = (path) => String(path).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")

/** Exported for the worker contract test/debug surface; contains no I/O. */
export function buildPartialEditFfmpegArgs({
  inputFile,
  outFile,
  contract,
  hasAudio,
  subtitleFile = null,
  musicFile = null,
  voiceoverFile = null,
}) {
  const visual = contract.rerender.includes('visual')
  const captions = contract.rerender.includes('captions') && Boolean(subtitleFile)
  const audio = contract.rerender.includes('audio')
  const parts = []
  let videoTail = '[0:v]'
  let audioTail = hasAudio ? '[0:a]' : null

  if (visual) {
    contract.segments.forEach((segment, index) => {
      parts.push(`[0:v]trim=start=${segment.startSec}:end=${segment.endSec},setpts=PTS-STARTPTS[v${index}]`)
      if (hasAudio) parts.push(`[0:a]atrim=start=${segment.startSec}:end=${segment.endSec},asetpts=PTS-STARTPTS[a${index}]`)
    })
    if (contract.segments.length === 1) {
      videoTail = '[v0]'
      audioTail = hasAudio ? '[a0]' : null
    } else {
      const inputs = contract.segments.map((_, index) => hasAudio ? `[v${index}][a${index}]` : `[v${index}]`).join('')
      parts.push(`${inputs}concat=n=${contract.segments.length}:v=1:a=${hasAudio ? 1 : 0}[vconcat]${hasAudio ? '[aconcat]' : ''}`)
      videoTail = '[vconcat]'
      audioTail = hasAudio ? '[aconcat]' : null
    }
  }

  const videoFilters = []
  const size = CROP_SIZES[contract.crop.aspect]
  if (visual && size) {
    const [width, height] = size
    const focusX = Number(contract.crop.focusX ?? 0.5)
    const focusY = Number(contract.crop.focusY ?? 0.5)
    videoFilters.push(
      `crop=w='min(iw,ih*${width}/${height})':h='min(ih,iw*${height}/${width})':x='(iw-ow)*${focusX}':y='(ih-oh)*${focusY}'`,
      `scale=${width}:${height}`,
    )
  }
  videoFilters.push('setsar=1', 'format=yuv420p')
  if (captions) {
    const alignment = contract.captionPlacement === 'top' ? 8 : contract.captionPlacement === 'center' ? 5 : 2
    videoFilters.push(
      `subtitles='${escapeSubtitlePath(subtitleFile)}':force_style='FontName=Noto Sans Bengali,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00111111,BorderStyle=1,Outline=2,Shadow=0,Alignment=${alignment},MarginV=120'`,
    )
  }
  parts.push(`${videoTail}${videoFilters.join(',')}[vout]`)

  const args = ['-y', '-i', inputFile]
  let nextInput = 1
  const musicInput = musicFile ? nextInput++ : -1
  const voiceInput = voiceoverFile ? nextInput++ : -1
  if (musicFile) args.push('-i', musicFile)
  if (voiceoverFile) args.push('-i', voiceoverFile)

  let mappedAudio = audioTail
  if (audio) {
    const mixLabels = []
    if (audioTail) {
      parts.push(`${audioTail}volume=${Number(contract.volumes.original ?? 1)}[aoriginal]`)
      mixLabels.push('[aoriginal]')
    }
    const duration = contract.segments.reduce((sum, segment) => sum + segment.endSec - segment.startSec, 0)
    if (musicInput >= 0) {
      parts.push(
        `[${musicInput}:a]aloop=loop=-1:size=2e9,atrim=0:${duration},aformat=sample_rates=48000:channel_layouts=stereo,volume=${Number(contract.volumes.music ?? 0.35)}[amusic]`,
      )
      mixLabels.push('[amusic]')
    }
    if (voiceInput >= 0) {
      parts.push(
        `[${voiceInput}:a]atrim=0:${duration},aformat=sample_rates=48000:channel_layouts=stereo,volume=${Number(contract.volumes.voiceover ?? 1)}[avoice]`,
      )
      mixLabels.push('[avoice]')
    }
    if (mixLabels.length > 1) {
      parts.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0[aout]`)
      mappedAudio = '[aout]'
    } else if (mixLabels.length === 1) {
      mappedAudio = mixLabels[0]
    } else {
      mappedAudio = null
    }
  }
  return [
    ...args,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    ...(mappedAudio ? ['-map', mappedAudio, '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-movflags', '+faststart',
    outFile,
  ]
}

/**
 * CSE5 partial rerender. The visual source path is never regenerated or
 * replaced: ffmpeg derives a new local version only for requested tracks.
 */
export async function processPartialVideoEdit(job, { supabase, callJobResult }) {
  const { pendingActionId, payload } = job.data
  const { sourceActionId, sourcePath, editContract: contract } = payload ?? {}
  if (!sourcePath || !contract?.segments?.length || contract.preserveVisualSource !== true) {
    await callJobResult(pendingActionId, 'failed', undefined, 'partial video edit payload incomplete')
    return
  }
  await ensureFfmpeg()
  const workDir = join(tmpdir(), `alma-video-partial-${pendingActionId}`)
  await mkdir(workDir, { recursive: true })
  const inputFile = join(workDir, 'source.mp4')
  const outFile = join(workDir, 'edited.mp4')
  const coverFile = join(workDir, 'cover.jpg')
  const subtitleFile = join(workDir, 'captions.srt')
  const musicFile = join(workDir, 'music-track')
  const voiceoverFile = join(workDir, 'voiceover-track.mp3')

  try {
    await reportProgress(supabase, pendingActionId, 1)
    await downloadToFile(supabase, sourcePath, inputFile)
    await reportProgress(supabase, pendingActionId, 2)
    const { hasAudio } = await probeVideo(inputFile)
    const captionSrt = buildCaptionSrt(contract)
    if (captionSrt) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(subtitleFile, captionSrt, 'utf8')
    }

    const onlyCover = contract.rerender.length === 1 && contract.rerender[0] === 'cover'
    let finalPath = sourcePath
    if (!onlyCover) {
      let downloadedMusic = null
      let downloadedVoiceover = null
      if (contract.rerender.includes('audio') && payload.audioTrackPaths?.music) {
        await downloadToFile(supabase, payload.audioTrackPaths.music, musicFile)
        downloadedMusic = musicFile
      }
      if (contract.rerender.includes('audio') && payload.audioTrackPaths?.voiceover) {
        await downloadToFile(supabase, payload.audioTrackPaths.voiceover, voiceoverFile)
        downloadedVoiceover = voiceoverFile
      }
      await reportProgress(supabase, pendingActionId, 4)
      const args = buildPartialEditFfmpegArgs({
        inputFile,
        outFile,
        contract,
        hasAudio,
        subtitleFile: captionSrt ? subtitleFile : null,
        musicFile: downloadedMusic,
        voiceoverFile: downloadedVoiceover,
      })
      await execFileAsync('ffmpeg', args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })
      await reportProgress(supabase, pendingActionId, 5)
      finalPath = `generated/${pendingActionId}-partial.mp4`
      const { error } = await supabase.storage
        .from('agent-files')
        .upload(finalPath, await readFile(outFile), { contentType: 'video/mp4', upsert: true })
      if (error) throw new Error(`partial upload failed: ${error.message}`)
    }

    let coverPath = null
    if (contract.rerender.includes('cover')) {
      const coverSource = onlyCover ? inputFile : outFile
      await execFileAsync('ffmpeg', [
        '-y', '-ss', String(contract.cover.atSec), '-i', coverSource,
        '-frames:v', '1', '-vf', 'scale=480:-2', coverFile,
      ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
      coverPath = `generated/${pendingActionId}-cover.jpg`
      const { error } = await supabase.storage
        .from('agent-files')
        .upload(coverPath, await readFile(coverFile), { contentType: 'image/jpeg', upsert: true })
      if (error) throw new Error(`cover upload failed: ${error.message}`)
    }

    await reportProgress(supabase, pendingActionId, 6)
    if (sourceActionId) {
      const { data: source } = await supabase
        .from('agent_pending_actions')
        .select('result')
        .eq('id', sourceActionId)
        .maybeSingle()
      const sourceResult = source?.result ?? {}
      const { error } = await supabase
        .from('agent_pending_actions')
        .update({
          result: {
            ...sourceResult,
            ...(onlyCover ? {} : { editedPath: finalPath, brandedPath: finalPath }),
            ...(coverPath ? { editedThumbPath: coverPath, brandedThumbPath: coverPath } : {}),
            editContract: contract,
            editSourcePath: sourcePath,
            editedAt: new Date().toISOString(),
          },
        })
        .eq('id', sourceActionId)
      if (error) throw new Error(`source edit record failed: ${error.message}`)
    }
    await callJobResult(pendingActionId, 'success', {
      storagePath: finalPath,
      sourcePath,
      sourceActionId,
      mediaType: 'video',
      editContract: contract,
      rerenderedTracks: contract.rerender,
      visualSourceRegenerated: false,
      costUsd: 0,
      ...(coverPath ? { coverPath } : {}),
    })
    console.log(`[worker] video-edit ${pendingActionId} — partial ${contract.rerender.join(',')} → ${finalPath}`)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * @param {import('bullmq').Job} job
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient,
 *           callJobResult: (id: string, status: string, data?: object, error?: string) => Promise<void> }} deps
 */
export async function processVideoEdit(job, { supabase, callJobResult }) {
  const { pendingActionId, payload } = job.data

  // V4: stitch finished Veo clips into one long reel (crossfade, one encode)
  if (payload?.veoConcat) {
    const { processVeoConcat } = await import('./video-post.mjs')
    await ensureFfmpeg()
    await processVeoConcat(job, { supabase, callJobResult, reportProgress })
    return
  }

  if (!payload?.videoPath || !payload?.recipeId || !payload?.targetSec) {
    await callJobResult(pendingActionId, 'failed', undefined, 'video_edit payload incomplete')
    return
  }

  const { videoPath, recipeId, targetSec, aspect = '9:16' } = payload
  console.log(`[worker] video-edit ${pendingActionId} — ${recipeId} ${targetSec}s ${aspect} ← ${videoPath}`)

  await ensureFfmpeg()

  const workDir = join(tmpdir(), `alma-video-edit-${pendingActionId}`)
  await mkdir(workDir, { recursive: true })
  const inputFile = join(workDir, 'source.mp4')
  const outFile = join(workDir, 'reel.mp4')
  const thumbFile = join(workDir, 'thumb.jpg')

  try {
    await reportProgress(supabase, pendingActionId, 1)
    await downloadToFile(supabase, videoPath, inputFile)

    await reportProgress(supabase, pendingActionId, 2)
    const { durationSec, hasAudio, isHdr } = await probeVideo(inputFile)
    let sceneChanges = await detectScenes(supabase, videoPath, inputFile)
    // V4 AI-assist (owner toggles per run, OFF by default): Gemini suggests
    // highlight timestamps that are ADDED to scdet's cuts — the deterministic
    // planner still decides everything; a failure falls back silently.
    if (payload.aiAssist) {
      try {
        const { suggestHighlights } = await import('./video-post.mjs')
        const extra = await suggestHighlights({ inputFile, durationSec })
        if (extra.length) sceneChanges = Array.from(new Set([...sceneChanges, ...extra])).sort((a, b) => a - b)
        console.log(`[worker] video-edit ${pendingActionId} — AI assist added ${extra.length} highlights`)
      } catch (err) {
        console.warn(`[worker] video-edit ${pendingActionId} — AI assist failed (scdet only):`, err?.message)
      }
    }
    console.log(`[worker] video-edit ${pendingActionId} — ${durationSec.toFixed(1)}s, ${sceneChanges.length} scene cuts${isHdr ? ', HDR' : ''}`)

    await reportProgress(supabase, pendingActionId, 3)
    const { plan, output } = await fetchCutPlan({ recipeId, durationSec, sceneChanges, targetSec, aspect })

    await reportProgress(supabase, pendingActionId, 4)
    await renderOutput({ inputFile, outFile, plan, output, hasAudio, isHdr })

    // ── Phase V2: captions + soundtrack + stings + cover frames ────────────
    await reportProgress(supabase, pendingActionId, 5)
    const { applyPostLayers, extractCoverCandidates } = await import('./video-post.mjs')
    const post = await applyPostLayers({
      supabase,
      workDir,
      reelFile: outFile,
      payload,
      output,
    })
    if (post.warnings.length) {
      console.warn(`[worker] video-edit ${pendingActionId} — post warnings: ${post.warnings.join(', ')}`)
    }
    const finalFile = post.finalFile
    const coverFiles = await extractCoverCandidates({
      file: finalFile,
      workDir,
      durationSec: plan.totalSec,
    })

    await execFileAsync(
      'ffmpeg',
      ['-y', '-ss', '0.5', '-i', finalFile, '-frames:v', '1', '-vf', 'scale=480:-2', thumbFile],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    ).catch(() => { /* thumbnail is optional */ })

    // CS11 — deterministic QC gate on the FINAL owner-shot reel: critical
    // black/frozen/corrupt outputs are rejected (sanitized Bangla error);
    // metrics (incl measured loudness) ship in the result either way.
    const { runVideoQc } = await import('./video-qc.mjs')
    let videoQc = null
    try {
      videoQc = await runVideoQc({ file: finalFile, expectedDurationSec: plan.totalSec })
    } catch (qcErr) {
      console.warn(`[worker] video-edit ${pendingActionId} — QC skipped: ${qcErr.message}`)
    }
    if (videoQc && !videoQc.pass) {
      throw new Error(videoQc.critical[0] ?? 'QC_DURATION: reel failed quality gate')
    }

    await reportProgress(supabase, pendingActionId, 6)
    const storagePath = `generated/${pendingActionId}.mp4`
    const videoBuffer = await readFile(finalFile)
    const { error: upErr } = await supabase.storage
      .from('agent-files')
      .upload(storagePath, videoBuffer, { contentType: 'video/mp4', upsert: true })
    if (upErr) throw new Error(`Supabase upload failed: ${upErr.message}`)

    let thumbPath = null
    try {
      const thumbBuffer = await readFile(thumbFile)
      thumbPath = `generated/${pendingActionId}-thumb.jpg`
      const { error: thumbErr } = await supabase.storage
        .from('agent-files')
        .upload(thumbPath, thumbBuffer, { contentType: 'image/jpeg', upsert: true })
      if (thumbErr) thumbPath = null
    } catch { thumbPath = null }

    // Persist the already-generated voiceover stem so CSE5 can change its
    // volume later without calling TTS again. Music already has a durable
    // owner-approved source path in the job payload.
    let voiceoverPath = null
    if (payload.voiceoverText) {
      try {
        voiceoverPath = `generated/${pendingActionId}-voiceover.mp3`
        const { error: voiceErr } = await supabase.storage
          .from('agent-files')
          .upload(voiceoverPath, await readFile(join(workDir, 'voiceover.mp3')), {
            contentType: 'audio/mpeg',
            upsert: true,
          })
        if (voiceErr) voiceoverPath = null
      } catch {
        voiceoverPath = null
      }
    }

    // cover candidates for the Gallery picker (best-effort)
    const coverCandidates = []
    for (let i = 0; i < coverFiles.length; i++) {
      try {
        const coverStorage = `generated/${pendingActionId}-cover-${i + 1}.jpg`
        const { error: coverErr } = await supabase.storage
          .from('agent-files')
          .upload(coverStorage, await readFile(coverFiles[i]), { contentType: 'image/jpeg', upsert: true })
        if (!coverErr) coverCandidates.push(coverStorage)
      } catch { /* skip */ }
    }

    await callJobResult(pendingActionId, 'success', {
      storagePath,
      ...(thumbPath ? { thumbPath } : {}),
      ...(coverCandidates.length ? { coverCandidates } : {}),
      mediaType: 'video',
      recipeId,
      aspect,
      durationSec: plan.totalSec,
      segments: plan.segments.length,
      sourcePath: videoPath,
      postApplied: post.applied,
      ...(typeof payload.musicPath === 'string' ? { musicPath: payload.musicPath } : {}),
      ...(voiceoverPath ? { voiceoverPath } : {}),
      ...(post.warnings.length ? { postWarnings: post.warnings } : {}),
      // CS11 — QC metrics + loudness; ffmpeg-only edits carry zero API cost
      ...(videoQc ? { videoQc: { pass: videoQc.pass, warnings: videoQc.warnings, metrics: videoQc.metrics } } : {}),
      costUsd: 0,
    })
    console.log(`[worker] video-edit ${pendingActionId} — done → ${storagePath} (${plan.segments.length} cuts, ${plan.totalSec}s)`)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
