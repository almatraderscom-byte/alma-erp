#!/usr/bin/env node
/**
 * Bulk import product images from a folder.
 * Files: <CODE>.jpg, <CODE>-2.jpg, <CODE>_2.jpg
 *
 * Usage: node worker/scripts/import-product-images.mjs <directory>
 */
import 'dotenv/config'
import { readdir, readFile } from 'fs/promises'
import path from 'path'

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: node worker/scripts/import-product-images.mjs <directory>')
  process.exit(1)
}

const APP_URL = process.env.APP_URL?.replace(/\/$/, '')
const TOKEN = process.env.AGENT_INTERNAL_TOKEN
if (!APP_URL || !TOKEN) {
  console.error('APP_URL and AGENT_INTERNAL_TOKEN required')
  process.exit(1)
}

const FILE_RE = /^([A-Za-z0-9][\w-]*?)(?:[-_](\d+))?\.(jpe?g|png|webp)$/i

async function upload(code, buffer) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/catalog/image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      productCode: code,
      imageBase64: buffer.toString('base64'),
      uploadedByChatId: 'import-script',
    }),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(`${code}: ${data.reason ?? data.error ?? res.status}`)
  }
  return data
}

const files = await readdir(dir)
let ok = 0
let fail = 0

for (const file of files.sort()) {
  const m = file.match(FILE_RE)
  if (!m) continue
  const code = m[1].toUpperCase()
  const buf = await readFile(path.join(dir, file))
  try {
    const r = await upload(code, buf)
    console.log(`✅ ${code} (${r.total}) ← ${file}`)
    ok += 1
  } catch (err) {
    console.error(`❌ ${file}: ${err.message}`)
    fail += 1
  }
}

console.log(`Done: ${ok} ok, ${fail} failed`)
