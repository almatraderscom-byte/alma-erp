import { ALLOWED_GENERIC_IMAGE_MODELS } from './reference-contract.mjs'

// Runtime mirror of src/agent/lib/image-action-contract.ts. The parity test in
// that module's test suite prevents either side from changing independently.
export const IMAGE_WORKER_CAPABILITY_KV_KEY = 'image_worker_capabilities_v1'
export const IMAGE_WORKER_CAPABILITY_VERSION = 1
export const IMAGE_WORKER_CAPABILITY_SOURCE = 'alma-agent-worker'
export const IMAGE_WORKER_CAPABILITY_PUBLISH_INTERVAL_MS = 60_000

const MODEL_ENV_KEYS = Object.freeze({
  'gemini-3.1-flash-image': 'GEMINI_API_KEY',
  'gemini-3-pro-image': 'GEMINI_API_KEY',
  'gpt-image-2': 'OPENAI_API_KEY',
  'seedream-5.0-pro': 'FAL_KEY',
})

function hasCredential(env, key) {
  return typeof env?.[key] === 'string' && env[key].trim().length > 0
}

/** Exact allowlisted generic-image models this process can execute right now. */
export function genericImageModelsFromWorkerEnv(env = process.env) {
  return ALLOWED_GENERIC_IMAGE_MODELS.filter((model) => {
    const envKey = MODEL_ENV_KEYS[model]
    if (!envKey) throw new Error(`missing capability env mapping: ${model}`)
    return hasCredential(env, envKey)
  })
}

export function makeImageWorkerCapabilityReceipt({
  env = process.env,
  now = new Date(),
} = {}) {
  const updatedAt = (now instanceof Date ? now : new Date(now)).toISOString()
  return {
    version: IMAGE_WORKER_CAPABILITY_VERSION,
    source: IMAGE_WORKER_CAPABILITY_SOURCE,
    updatedAt,
    models: genericImageModelsFromWorkerEnv(env),
  }
}

/** One atomic KV upsert. Provider credentials are never written to storage. */
export async function publishImageWorkerCapabilityReceipt({
  supabase,
  env = process.env,
  now = new Date(),
}) {
  const receipt = makeImageWorkerCapabilityReceipt({ env, now })
  const { error } = await supabase
    .from('agent_kv_settings')
    .upsert({
      key: IMAGE_WORKER_CAPABILITY_KV_KEY,
      value: JSON.stringify(receipt),
      updated_at: receipt.updatedAt,
    }, { onConflict: 'key' })
  if (error) throw error
  return receipt
}

/**
 * Publish once before normal polling, then refresh often enough that the
 * server's 3-minute lease can fail closed after this worker disappears.
 * Overlapping ticks share one in-flight write.
 */
export function startImageWorkerCapabilityPublisher({
  supabase,
  env = process.env,
  intervalMs = IMAGE_WORKER_CAPABILITY_PUBLISH_INTERVAL_MS,
  schedule = setInterval,
  unschedule = clearInterval,
  now = () => new Date(),
  onError = (error) => console.warn('[worker] image capability publish failed:', error?.message ?? error),
}) {
  let inFlight = null
  let stopped = false

  const refresh = async () => {
    if (stopped) return null
    if (inFlight) return inFlight
    inFlight = publishImageWorkerCapabilityReceipt({ supabase, env, now: now() })
      .catch((error) => {
        onError(error)
        return null
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  // Do not block the whole worker on a slow KV network call. `ready` lets tests
  // and diagnostics observe the first attempt, while the server remains safely
  // closed until one receipt actually lands.
  const ready = refresh()
  const timer = schedule(refresh, intervalMs)
  return {
    ready,
    refresh,
    stop() {
      if (stopped) return
      stopped = true
      unschedule(timer)
    },
  }
}
