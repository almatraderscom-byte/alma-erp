const DEFAULT_BUCKET = 'expense-receipts'

export type SupabaseUploadResult = {
  bucket: string
  objectPath: string
  publicUrl?: string
}

export function storageConfig() {
  const url = resolveSupabaseUrl()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  const bucket = process.env.SUPABASE_EXPENSE_RECEIPTS_BUCKET || DEFAULT_BUCKET
  if (!url || !serviceKey) {
    throw new Error('Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  }
  return { url: url.replace(/\/$/, ''), serviceKey, bucket }
}

export function storageReadiness() {
  const url = resolveSupabaseUrl()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  return {
    configured: Boolean(url && serviceKey),
    hasUrl: Boolean(url),
    hasServiceRoleKey: Boolean(serviceKey),
    bucket: process.env.SUPABASE_EXPENSE_RECEIPTS_BUCKET || DEFAULT_BUCKET,
  }
}

function resolveSupabaseUrl() {
  const candidates = [
    process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    inferSupabaseUrlFromDatabase(),
  ]
  return candidates.find(value => isSupabaseProjectUrl(value))?.replace(/\/$/, '') || ''
}

function isSupabaseProjectUrl(value: string | undefined | null) {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(value || '').trim().replace(/\/$/, ''))
}

function inferSupabaseUrlFromDatabase() {
  const raw = process.env.DATABASE_URL || ''
  const match = raw.match(/@(?:[^.]+\.)?([a-z0-9-]+)\.supabase\.co/i)
  if (!match?.[1]) return ''
  return `https://${match[1]}.supabase.co`
}

export async function ensureBucket() {
  const cfg = storageConfig()
  const res = await fetch(`${cfg.url}/storage/v1/bucket/${encodeURIComponent(cfg.bucket)}`, {
    headers: storageHeaders(cfg.serviceKey),
  })
  if (res.ok) return cfg
  if (res.status !== 404) throw new Error(`Supabase bucket check failed (${res.status})`)

  const create = await fetch(`${cfg.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...storageHeaders(cfg.serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: cfg.bucket, name: cfg.bucket, public: false, file_size_limit: '10485760' }),
  })
  if (!create.ok && create.status !== 409) {
    throw new Error(`Supabase bucket create failed (${create.status}): ${(await create.text()).slice(0, 200)}`)
  }
  return cfg
}

export async function uploadStorageObject(objectPath: string, file: Blob, contentType: string): Promise<SupabaseUploadResult> {
  const cfg = await ensureBucket()
  const res = await fetch(`${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}/${objectPath}`, {
    method: 'POST',
    headers: {
      ...storageHeaders(cfg.serviceKey),
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: file,
  })
  if (!res.ok) {
    throw new Error(`Receipt upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  return { bucket: cfg.bucket, objectPath }
}

export async function createSignedObjectUrl(bucket: string, objectPath: string, download = false) {
  const cfg = storageConfig()
  const res = await fetch(`${cfg.url}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${objectPath}`, {
    method: 'POST',
    headers: { ...storageHeaders(cfg.serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300, download }),
  })
  if (!res.ok) throw new Error(`Could not create signed receipt URL (${res.status})`)
  const data = await res.json() as { signedURL?: string; signedUrl?: string }
  const signedPath = data.signedURL || data.signedUrl
  if (!signedPath) throw new Error('Supabase did not return a signed URL')
  return `${cfg.url}/storage/v1${signedPath}`
}

function storageHeaders(serviceKey: string) {
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
  }
}
