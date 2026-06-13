/**
 * Supabase task-proofs bucket — ensure exists + upload staff proof photos.
 */
import { createClient } from '@supabase/supabase-js'

export const TASK_PROOFS_BUCKET = 'task-proofs'

function storageHeaders(serviceKey) {
  return { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
}

export async function ensureTaskProofsBucket() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')

  const base = url.replace(/\/$/, '')
  const check = await fetch(`${base}/storage/v1/bucket/${TASK_PROOFS_BUCKET}`, {
    headers: storageHeaders(key),
  })
  if (check.ok) return

  const create = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...storageHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: TASK_PROOFS_BUCKET,
      name: TASK_PROOFS_BUCKET,
      public: true,
      file_size_limit: 5 * 1024 * 1024,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
    }),
  })
  if (!create.ok && create.status !== 409) {
    const body = await create.text()
    throw new Error(`task-proofs bucket create failed ${create.status}: ${body.slice(0, 200)}`)
  }
}

export async function uploadTaskProofPhoto(supabase, taskId, fileBuffer, contentType = 'image/jpeg') {
  await ensureTaskProofsBucket()
  const path = `${taskId}.jpg`
  const { error } = await supabase.storage
    .from(TASK_PROOFS_BUCKET)
    .upload(path, fileBuffer, { upsert: true, contentType })

  if (!error) {
    const { data } = supabase.storage.from(TASK_PROOFS_BUCKET).getPublicUrl(path)
    return data.publicUrl
  }

  // Legacy fallback
  const altPath = `task-proofs/${path}`
  const alt = await supabase.storage
    .from('agent-files')
    .upload(altPath, fileBuffer, { upsert: true, contentType })
  if (alt.error) throw new Error(alt.error.message)
  const { data } = supabase.storage.from('agent-files').getPublicUrl(altPath)
  return data.publicUrl
}
