/**
 * Phase V3 — Remotion motion-template finishing on the VPS.
 *
 * The app's unit-tested planner ships a frame-exact overlay plan in the
 * payload; this processor renders it with Remotion to a TRANSPARENT vp8 webm
 * (React/Chrome never touches the reel pixels) and ffmpeg composites it over
 * the source reel — one encode, audio copied through. The finished version is
 * written back onto the SOURCE gallery item as its branded variant, exactly
 * like the image Finishing tab does.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)

const RENDER_TIMEOUT_MS = 20 * 60_000
const ENTRY_POINT = join(dirname(fileURLToPath(import.meta.url)), '..', 'remotion', 'index.jsx')

const STEPS_BN = [
  'সোর্স রিল ডাউনলোড হচ্ছে',
  'টেমপ্লেট রেন্ডার হচ্ছে (Remotion)',
  'রিলের সাথে মিশ্রণ হচ্ছে',
  'আপলোড হচ্ছে',
]

async function reportProgress(supabase, pendingActionId, step) {
  try {
    const { data } = await supabase
      .from('agent_pending_actions')
      .select('payload')
      .eq('id', pendingActionId)
      .maybeSingle()
    await supabase
      .from('agent_pending_actions')
      .update({
        payload: {
          ...(data?.payload ?? {}),
          _videoProgress: { step, total: STEPS_BN.length, labelBn: STEPS_BN[step - 1] ?? '' },
        },
      })
      .eq('id', pendingActionId)
  } catch (err) {
    console.warn(`[worker] video-finish ${pendingActionId} progress write failed:`, err?.message)
  }
}

// The webpack bundle is expensive (~30-60s) — build once per process.
let bundlePromise = null
async function getServeUrl() {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const { bundle } = await import('@remotion/bundler')
      console.log('[worker] video-finish — bundling Remotion project (once per boot)')
      return bundle({
        entryPoint: ENTRY_POINT,
        // bundler doesn't infer public/ next to the entry point — be explicit
        publicDir: join(dirname(ENTRY_POINT), 'public'),
      })
    })().catch((err) => {
      bundlePromise = null // allow retry on next job
      throw err
    })
  }
  return bundlePromise
}

/** Pre-warm Chrome Headless Shell + the webpack bundle (startup, best-effort). */
export async function videoFinishPreflight() {
  const { ensureBrowser } = await import('@remotion/renderer')
  await ensureBrowser()
  await getServeUrl()
  console.log('[worker] video-finish preflight OK (browser + bundle ready)')
}

async function downloadToFile(supabase, storagePath, destFile) {
  const { data, error } = await supabase.storage.from('agent-files').download(storagePath)
  if (error || !data) throw new Error(`download failed for ${storagePath}: ${error?.message}`)
  await writeFile(destFile, Buffer.from(await data.arrayBuffer()))
}

/**
 * @param {import('bullmq').Job} job
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient,
 *           callJobResult: (id: string, status: string, data?: object, error?: string) => Promise<void> }} deps
 */
export async function processVideoFinish(job, { supabase, callJobResult }) {
  const { pendingActionId, payload } = job.data
  const { sourceActionId, sourcePath, plan, brandLogoPath } = payload ?? {}
  if (!sourcePath || !plan?.items?.length) {
    await callJobResult(pendingActionId, 'failed', undefined, 'video_finish payload incomplete')
    return
  }
  console.log(`[worker] video-finish ${pendingActionId} — ${plan.items.map((i) => i.kind).join(',')} ← ${sourcePath}`)

  const workDir = join(tmpdir(), `alma-video-finish-${pendingActionId}`)
  await mkdir(workDir, { recursive: true })
  const reelFile = join(workDir, 'reel.mp4')
  const overlayFile = join(workDir, 'overlay.webm')
  const outFile = join(workDir, 'finished.mp4')
  const thumbFile = join(workDir, 'thumb.jpg')

  try {
    await reportProgress(supabase, pendingActionId, 1)
    await downloadToFile(supabase, sourcePath, reelFile)

    let logoDataUrl = null
    if (plan.needsLogo && brandLogoPath) {
      const logoFile = join(workDir, 'logo.png')
      await downloadToFile(supabase, brandLogoPath, logoFile)
      logoDataUrl = `data:image/png;base64,${(await readFile(logoFile)).toString('base64')}`
    }

    await reportProgress(supabase, pendingActionId, 2)
    const { renderMedia, selectComposition, ensureBrowser } = await import('@remotion/renderer')
    await ensureBrowser()
    const serveUrl = await getServeUrl()
    const inputProps = { plan, logoDataUrl }
    const composition = await selectComposition({ serveUrl, id: 'FinishOverlay', inputProps })
    await renderMedia({
      composition,
      serveUrl,
      codec: 'vp8',
      imageFormat: 'png',
      pixelFormat: 'yuva420p',
      inputProps,
      outputLocation: overlayFile,
      concurrency: 2,
      timeoutInMilliseconds: RENDER_TIMEOUT_MS,
    })

    await reportProgress(supabase, pendingActionId, 3)
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', reelFile,
      '-c:v', 'libvpx', '-i', overlayFile,
      '-filter_complex', '[0:v][1:v]overlay=0:0:eof_action=pass[v]',
      '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outFile,
    ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })
    await execFileAsync(
      'ffmpeg',
      ['-y', '-ss', '0.5', '-i', outFile, '-frames:v', '1', '-vf', 'scale=480:-2', thumbFile],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    ).catch(() => {})

    await reportProgress(supabase, pendingActionId, 4)
    const brandedPath = `generated/${pendingActionId}-finished.mp4`
    const { error: upErr } = await supabase.storage
      .from('agent-files')
      .upload(brandedPath, await readFile(outFile), { contentType: 'video/mp4', upsert: true })
    if (upErr) throw new Error(`upload failed: ${upErr.message}`)

    let brandedThumbPath = null
    try {
      brandedThumbPath = `generated/${pendingActionId}-finished-thumb.jpg`
      const { error: thErr } = await supabase.storage
        .from('agent-files')
        .upload(brandedThumbPath, await readFile(thumbFile), { contentType: 'image/jpeg', upsert: true })
      if (thErr) brandedThumbPath = null
    } catch { brandedThumbPath = null }

    // Attach the finished variant to the SOURCE gallery item (image-finishing
    // pattern: brandedPath lives on the item the owner opened).
    if (sourceActionId) {
      try {
        const { data: src } = await supabase
          .from('agent_pending_actions')
          .select('result')
          .eq('id', sourceActionId)
          .maybeSingle()
        await supabase
          .from('agent_pending_actions')
          .update({
            result: {
              ...(src?.result ?? {}),
              brandedPath,
              ...(brandedThumbPath ? { brandedThumbPath } : {}),
              finishTemplates: plan.items.map((i) => i.kind),
              finishedAt: new Date().toISOString(),
            },
          })
          .eq('id', sourceActionId)
      } catch (err) {
        console.warn(`[worker] video-finish ${pendingActionId} — source update failed:`, err?.message)
      }
    }

    await callJobResult(pendingActionId, 'success', {
      storagePath: brandedPath,
      brandedPath,
      ...(brandedThumbPath ? { brandedThumbPath } : {}),
      sourceActionId,
      mediaType: 'video',
      templates: plan.items.map((i) => i.kind),
    })
    console.log(`[worker] video-finish ${pendingActionId} — done → ${brandedPath}`)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
