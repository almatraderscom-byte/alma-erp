#!/usr/bin/env node
/**
 * Create + verify Supabase storage bucket `task-proofs` (public read for owner Telegram photos).
 * Usage: cd worker && node scripts/setup-task-proofs-bucket.mjs
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'task-proofs'
const MAX_BYTES = 5 * 1024 * 1024

function headers(serviceKey) {
  return { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
}

async function ensureBucket(url, serviceKey) {
  const base = url.replace(/\/$/, '')
  const check = await fetch(`${base}/storage/v1/bucket/${BUCKET}`, { headers: headers(serviceKey) })
  if (check.ok) {
    console.log(`✅ Bucket "${BUCKET}" already exists`)
    return base
  }

  const create = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...headers(serviceKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: true,
      file_size_limit: MAX_BYTES,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
    }),
  })

  if (create.ok || create.status === 409) {
    console.log(`✅ Bucket "${BUCKET}" created (or already present)`)
    return base
  }

  const body = await create.text()
  throw new Error(`Create bucket failed HTTP ${create.status}: ${body.slice(0, 300)}`)
}

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')
    process.exit(1)
  }

  const base = await ensureBucket(url, key)
  const supabase = createClient(url, key)

  // Minimal 1x1 JPEG
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=',
    'base64',
  )

  const testPath = `_verify/${Date.now()}.jpg`
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(testPath, jpeg, {
    upsert: true,
    contentType: 'image/jpeg',
  })
  if (upErr) throw new Error(`Upload test failed: ${upErr.message}`)

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(testPath)
  const publicUrl = pub.publicUrl
  const head = await fetch(publicUrl, { method: 'HEAD' })
  if (!head.ok) throw new Error(`Public URL not reachable: ${head.status} ${publicUrl}`)

  await supabase.storage.from(BUCKET).remove([testPath])

  console.log('✅ Upload + public URL verified:', publicUrl.replace(testPath, '<taskId>.jpg'))
  console.log('=== task-proofs bucket ready ===')
}

main().catch((err) => {
  console.error('❌', err.message)
  process.exit(1)
})
