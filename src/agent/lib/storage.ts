/**
 * Supabase Storage wrapper for agent-files bucket.
 * Mirrors the pattern in src/lib/supabase-storage.ts but uses the agent-files bucket.
 */

const AGENT_BUCKET = 'agent-files'
const DOWNLOAD_TIMEOUT_MS = 9_000

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
  })
  if (check.ok) return { url, serviceKey }

  const create = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: AGENT_BUCKET,
      name: AGENT_BUCKET,
      public: false,
      file_size_limit: 10 * 1024 * 1024,
    }),
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
  })
  if (!res.ok) {
    throw new Error(`Agent file upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  return { bucket: AGENT_BUCKET, objectPath }
}

/** Signed URL for private agent-files objects (default 1 hour). */
export async function agentStorageSignedUrl(objectPath: string, expiresIn = 3600): Promise<string> {
  const { url, serviceKey } = getStorageBase()
  const res = await fetch(`${url}/storage/v1/object/sign/${AGENT_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  })
  if (!res.ok) {
    throw new Error(`Agent signed URL failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json() as { signedURL?: string; signedUrl?: string }
  const signedPath = data.signedURL || data.signedUrl
  if (!signedPath) throw new Error('Supabase did not return a signed URL')
  return `${url}/storage/v1${signedPath}`
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

export async function agentStorageDownload(objectPath: string): Promise<Buffer> {
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
