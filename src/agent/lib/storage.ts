/**
 * Supabase Storage wrapper for agent-files bucket.
 * Mirrors the pattern in src/lib/supabase-storage.ts but uses the agent-files bucket.
 */

const AGENT_BUCKET = 'agent-files'
const DOWNLOAD_TIMEOUT_MS = 9_000
// Creative Studio videos need large files: Veo reels broke the old 10 MB image
// limit, and Phase V1 lets the owner upload his own 1–2 min phone shoots
// (iPhone HEVC, up to ~500 MB) via signed direct upload. Kept as low as the
// feature allows because originals are archived to Google Drive and cleaned
// out of Supabase afterwards.
const AGENT_BUCKET_FILE_LIMIT = 512 * 1024 * 1024 // 512 MB

function getStorageBase() {
  const candidates = [
    process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ]
  const url = candidates.find(v => /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(v || '').trim()))
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for agent file storage.')
  }
  return { url: url.replace(/\/$/, ''), serviceKey }
}

function storageHeaders(serviceKey: string) {
  return { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
}

async function ensureAgentBucket() {
  const { url, serviceKey } = getStorageBase()
  const check = await fetch(`${url}/storage/v1/bucket/${AGENT_BUCKET}`, {
    headers: storageHeaders(serviceKey),
    signal: AbortSignal.timeout(10_000),
  })
  if (check.ok) {
    // Self-heal: older buckets were created with a 10 MB limit that rejects
    // Creative Studio videos. Raise it once when below target (idempotent —
    // after the first PATCH this branch is skipped).
    try {
      const cfg = (await check.json()) as { file_size_limit?: number | null }
      const current = Number(cfg.file_size_limit ?? 0)
      if (current > 0 && current < AGENT_BUCKET_FILE_LIMIT) {
        await fetch(`${url}/storage/v1/bucket/${AGENT_BUCKET}`, {
          method: 'PUT',
          headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: AGENT_BUCKET, name: AGENT_BUCKET, public: false, file_size_limit: AGENT_BUCKET_FILE_LIMIT }),
          signal: AbortSignal.timeout(10_000),
        }).catch((err) => console.warn('[storage] bucket limit raise failed:', err?.message))
      }
    } catch {
      // Non-fatal: if we can't read/raise the limit, uploads still proceed.
    }
    return { url, serviceKey }
  }

  const create = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: AGENT_BUCKET,
      name: AGENT_BUCKET,
      public: false,
      file_size_limit: AGENT_BUCKET_FILE_LIMIT,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!create.ok && create.status !== 409) {
    throw new Error(`Failed to create agent-files bucket: ${create.status}`)
  }
  return { url, serviceKey }
}

export async function agentStorageUpload(
  objectPath: string,
  data: Buffer,
  contentType: string,
  opts?: { upsert?: boolean },
): Promise<{ bucket: string; objectPath: string }> {
  const { url, serviceKey } = await ensureAgentBucket()
  const res = await fetch(`${url}/storage/v1/object/${AGENT_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      ...storageHeaders(serviceKey),
      'Content-Type': contentType,
      'x-upsert': opts?.upsert ? 'true' : 'false',
    },
    body: data,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`Agent file upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  return { bucket: AGENT_BUCKET, objectPath }
}

/**
 * Signed UPLOAD URL: the browser PUTs the file straight into Supabase storage,
 * bypassing Vercel's request-body limits entirely — this is how Phase V1 gets
 * ~500 MB phone videos in. Returns an absolute URL valid for ~2 hours.
 */
export async function agentStorageSignedUploadUrl(objectPath: string): Promise<string> {
  const { url, serviceKey } = await ensureAgentBucket()
  const res = await fetch(`${url}/storage/v1/object/upload/sign/${AGENT_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Agent signed upload URL failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json() as { url?: string }
  if (!data.url) throw new Error('Supabase did not return a signed upload URL')
  return `${url}/storage/v1${data.url}`
}

/** Object metadata (null when the object does not exist) — used to verify a
 * signed direct upload actually landed before registering it. HEAD on the
 * download endpoint: works on every storage-api version, no body transfer. */
export async function agentStorageObjectInfo(
  objectPath: string,
): Promise<{ size: number; contentType: string | null } | null> {
  const { url, serviceKey } = getStorageBase()
  const res = await fetch(`${url}/storage/v1/object/${AGENT_BUCKET}/${objectPath}`, {
    method: 'HEAD',
    headers: storageHeaders(serviceKey),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 404 || res.status === 400) return null
  if (!res.ok) throw new Error(`Agent object info failed (${res.status})`)
  return {
    size: Number(res.headers.get('content-length') ?? 0),
    contentType: res.headers.get('content-type'),
  }
}

/** Delete agent-files objects (best-effort batch). */
export async function agentStorageDelete(objectPaths: string[]): Promise<void> {
  const paths = objectPaths.filter(Boolean)
  if (paths.length === 0) return
  const { url, serviceKey } = getStorageBase()
  const res = await fetch(`${url}/storage/v1/object/${AGENT_BUCKET}`, {
    method: 'DELETE',
    headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Agent file delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
}

/** Signed URL for private agent-files objects (default 1 hour). */
export async function agentStorageSignedUrl(objectPath: string, expiresIn = 3600): Promise<string> {
  const { url, serviceKey } = getStorageBase()
  const res = await fetch(`${url}/storage/v1/object/sign/${AGENT_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Agent signed URL failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json() as { signedURL?: string; signedUrl?: string }
  const signedPath = data.signedURL || data.signedUrl
  if (!signedPath) throw new Error('Supabase did not return a signed URL')
  return `${url}/storage/v1${signedPath}`
}

/**
 * Sign many objects in ONE request (Supabase batch sign endpoint). Returns a
 * map of objectPath → signed URL; paths that fail to sign are simply absent.
 * Used by the gallery so we don't fire one round-trip per image.
 */
export async function agentStorageSignedUrls(
  objectPaths: string[],
  expiresIn = 3600,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const paths = Array.from(new Set(objectPaths.filter(Boolean)))
  if (paths.length === 0) return out
  const { url, serviceKey } = getStorageBase()
  const res = await fetch(`${url}/storage/v1/object/sign/${AGENT_BUCKET}`, {
    method: 'POST',
    headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn, paths }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Agent batch signed URL failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const rows = (await res.json()) as Array<{ path?: string; signedURL?: string; signedUrl?: string; error?: string | null }>
  for (const row of rows) {
    const signed = row.signedURL || row.signedUrl
    if (row.path && signed && !row.error) {
      out[row.path] = `${url}/storage/v1${signed}`
    }
  }
  return out
}

/** Copy an agent-files object to a stable path (upsert). */
export async function agentStorageCopy(
  sourcePath: string,
  destPath: string,
  contentType = 'image/png',
): Promise<{ bucket: string; objectPath: string }> {
  const buf = await agentStorageDownload(sourcePath)
  return agentStorageUpload(destPath, buf, contentType, { upsert: true })
}

const DOWNLOAD_MAX_ATTEMPTS = 3

async function agentStorageDownloadOnce(objectPath: string): Promise<Buffer> {
  const { url, serviceKey } = getStorageBase()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(`${url}/storage/v1/object/${AGENT_BUCKET}/${objectPath}`, {
      headers: storageHeaders(serviceKey),
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Agent file download failed (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download an agent-files object, retrying transient failures.
 *
 * Screenshots the owner pastes into the agent chat are read through THIS funnel
 * (both the native image-attach path in core.ts and the read_screenshot tool).
 * A single transient Supabase 5xx / timeout used to make the image silently fail
 * to load — the agent then went blind and told the owner it "couldn't read" the
 * screenshot. A 404 (object genuinely missing) is NOT retried — that won't
 * recover and we want to fail fast.
 */
export async function agentStorageDownload(objectPath: string): Promise<Buffer> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await agentStorageDownloadOnce(objectPath)
    } catch (err) {
      lastErr = err
      // 404 = object missing; retrying can't help. Bail immediately.
      if (err instanceof Error && /\(404\)/.test(err.message)) break
      if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 400 * attempt))
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Agent file download failed')
}
