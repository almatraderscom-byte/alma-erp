/**
 * FASHN API — VPS worker (mirrors src/lib/fashn/client.ts)
 */
const FASHN_BASE = 'https://api.fashn.ai/v1'

function getApiKey() {
  const key = process.env.FASHN_API_KEY?.trim()
  if (!key) throw new Error('FASHN_API_KEY not configured on worker')
  return key
}

export async function fashnRun(modelName, inputs, opts = {}) {
  const body = {
    model_name: modelName,
    inputs: {
      ...inputs,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.resolution ? { resolution: opts.resolution } : {}),
      ...(opts.generationMode ? { generation_mode: opts.generationMode } : {}),
      ...(opts.numImages ? { num_images: opts.numImages } : {}),
      ...(opts.outputFormat ? { output_format: opts.outputFormat } : {}),
      ...(opts.returnBase64 ? { return_base64: true } : {}),
    },
  }

  const res = await fetch(`${FASHN_BASE}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? data.message ?? `FASHN HTTP ${res.status}`)
  if (!data.id) throw new Error('FASHN missing prediction id')
  return data
}

export async function fashnStatus(predictionId) {
  const res = await fetch(`${FASHN_BASE}/status/${encodeURIComponent(predictionId)}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    signal: AbortSignal.timeout(20_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `FASHN status HTTP ${res.status}`)
  return data
}

export async function fashnPollUntilDone(predictionId, { maxMs = 180_000, intervalMs = 4_000 } = {}) {
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    const st = await fashnStatus(predictionId)
    if (st.status === 'completed') return st
    if (st.status === 'failed') throw new Error(st.error ?? 'FASHN failed')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('FASHN timed out')
}

/**
 * Resolve agent-files path to base64 data URL for FASHN.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function storagePathToDataUrl(supabase, path) {
  const { data, error } = await supabase.storage.from('agent-files').download(path)
  if (error || !data) throw new Error(`download failed: ${path}`)
  const buf = Buffer.from(await data.arrayBuffer())
  const mime = data.type || 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function resolveFashnImageInputs(supabase, rawInputs) {
  const out = {}
  for (const [key, val] of Object.entries(rawInputs ?? {})) {
    if (!val || typeof val !== 'string') continue
    if (val.startsWith('http') || val.startsWith('data:')) {
      out[key] = val
    } else if (key === 'model_image') {
      // reseller model photos may carry a dark marketing plate — scrub first
      // (free, kv-cached, fail-open)
      const { cleanModelPhoto } = await import('../photo-cleanup.mjs')
      out[key] = await storagePathToDataUrl(supabase, await cleanModelPhoto({ supabase, imagePath: val }))
    } else {
      out[key] = await storagePathToDataUrl(supabase, val)
    }
  }
  return out
}

export async function downloadFashnOutputToStorage(supabase, outputUrl, pendingActionId, index = 0) {
  const res = await fetch(outputUrl, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`FASHN output download HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') ?? 'image/png'
  const ext = contentType.includes('jpeg') ? 'jpg' : 'png'
  const storagePath = `generated/studio-${pendingActionId}${index ? `-${index}` : ''}.${ext}`
  const { error } = await supabase.storage.from('agent-files').upload(storagePath, buf, {
    contentType,
    upsert: true,
  })
  if (error) throw new Error(`upload failed: ${error.message}`)
  return storagePath
}
