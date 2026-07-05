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

/**
 * @param {import('bullmq').Job} job
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient,
 *           callJobResult: (id: string, status: string, data?: object, error?: string) => Promise<void> }} deps
 */
export async function processVideoEdit(job, { supabase, callJobResult }) {
  const { pendingActionId, payload } = job.data
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
    const sceneChanges = await detectScenes(supabase, videoPath, inputFile)
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
      ...(post.warnings.length ? { postWarnings: post.warnings } : {}),
    })
    console.log(`[worker] video-edit ${pendingActionId} — done → ${storagePath} (${plan.segments.length} cuts, ${plan.totalSec}s)`)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
