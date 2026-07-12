/**
 * Phase E1 — Audio Lab worker (ElevenLabs). Executes owner-initiated
 * audio_gen jobs verbatim — prompts/lyrics are built app-side by the pure,
 * unit-tested builders; nothing creative is decided here.
 *
 * GUARDRAIL: the owner's cloned voice id lives in kv `studio_owner_voice_id`
 * and is read ONLY by kind:'owner_voice' jobs, which only the owner-auth
 * studio route creates. It must never be wired into autonomous/CS flows.
 */
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1'
const API_KEY = () => process.env.ELEVENLABS_API_KEY ?? ''

const OWNER_VOICE_KV = 'studio_owner_voice_id'

async function elFetch(path, init = {}, timeoutMs = 180_000) {
  const res = await fetch(`${ELEVENLABS_BASE}${path}`, {
    ...init,
    headers: { 'xi-api-key': API_KEY(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`elevenlabs ${path} ${res.status}: ${body.slice(0, 200)}`)
  }
  return res
}

async function downloadStorage(supabase, path) {
  const { data, error } = await supabase.storage.from('agent-files').download(path)
  if (error || !data) throw new Error(`download failed: ${error?.message}`)
  return Buffer.from(await data.arrayBuffer())
}

async function readKv(supabase, key) {
  const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', key).maybeSingle()
  return data?.value ?? null
}

/**
 * @param {import('bullmq').Job} job
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient,
 *           callJobResult: (id: string, status: string, data?: object, error?: string) => Promise<void> }} deps
 */
export async function processAudioGen(job, { supabase, callJobResult }) {
  const { pendingActionId, payload } = job.data
  const { kind } = payload ?? {}
  if (!API_KEY()) {
    await callJobResult(pendingActionId, 'failed', undefined, 'ELEVENLABS_API_KEY not set on the worker')
    return
  }
  console.log(`[worker] audio-lab ${pendingActionId} — ${kind}`)

  let audio = null // Buffer
  let contentType = 'audio/mpeg'
  let ext = 'mp3'
  let extraResult = {}

  if (kind === 'voice_clone') {
    // one-time: consented samples → ElevenLabs voice → id saved in kv
    const form = new FormData()
    form.append('name', 'ALMA Boss')
    form.append('description', 'Owner voice — studio use only')
    const paths = Array.isArray(payload.samplePaths) ? payload.samplePaths.slice(0, 5) : []
    if (paths.length === 0) throw new Error('no voice samples')
    for (let i = 0; i < paths.length; i++) {
      const buf = await downloadStorage(supabase, paths[i])
      form.append('files', new Blob([buf], { type: 'audio/mpeg' }), `sample-${i}.mp3`)
    }
    const res = await elFetch('/voices/add', { method: 'POST', body: form }, 300_000)
    const data = await res.json()
    if (!data.voice_id) throw new Error('no voice_id returned')
    await supabase
      .from('agent_kv_settings')
      .upsert({ key: OWNER_VOICE_KV, value: data.voice_id }, { onConflict: 'key' })
    await callJobResult(pendingActionId, 'success', { voiceId: data.voice_id, kind })
    console.log(`[worker] audio-lab ${pendingActionId} — voice cloned`)
    return
  }

  if (kind === 'music' || kind === 'wish_song') {
    const res = await elFetch('/music', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: String(payload.prompt ?? '').slice(0, 2000),
        music_length_ms: Math.min(120, Math.max(10, Number(payload.seconds ?? 30))) * 1000,
      }),
    }, 300_000)
    audio = Buffer.from(await res.arrayBuffer())
  } else if (kind === 'owner_voice') {
    const voiceId = await readKv(supabase, OWNER_VOICE_KV)
    if (!voiceId) throw new Error('owner voice not cloned yet')
    const { synthesizeElevenLabs } = await import('./tts-elevenlabs.mjs')
    audio = await synthesizeElevenLabs(String(payload.text ?? ''), { voiceId })
  } else if (kind === 'clean_voice') {
    const buf = await downloadStorage(supabase, String(payload.sourcePath ?? ''))
    const form = new FormData()
    form.append('audio', new Blob([buf], { type: 'audio/mpeg' }), 'note.mp3')
    const res = await elFetch('/audio-isolation', { method: 'POST', body: form }, 300_000)
    audio = Buffer.from(await res.arrayBuffer())
  } else if (kind === 'sfx') {
    const res = await elFetch('/sound-generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: String(payload.text ?? '').slice(0, 300),
        duration_seconds: Math.min(10, Math.max(0.5, Number(payload.seconds ?? 3))),
      }),
    })
    audio = Buffer.from(await res.arrayBuffer())
  } else {
    throw new Error(`unknown audio kind: ${kind}`)
  }

  const storagePath = `generated/${pendingActionId}.${ext}`
  const { error: upErr } = await supabase.storage
    .from('agent-files')
    .upload(storagePath, audio, { contentType, upsert: true })
  if (upErr) throw new Error(`upload failed: ${upErr.message}`)

  const { logCost } = await import('./cost-log.mjs')
  void logCost({
    provider: 'elevenlabs',
    kind: 'audio_lab',
    units: { kind, bytes: audio.length, pendingActionId },
    costUsd: Number(payload.costUsd ?? 0),
    jobId: pendingActionId,
    dedupKey: `audio:${pendingActionId}`,
  })

  await callJobResult(pendingActionId, 'success', {
    storagePath,
    mediaType: 'audio',
    kind,
    ...extraResult,
  })
  console.log(`[worker] audio-lab ${pendingActionId} — done → ${storagePath}`)
}
