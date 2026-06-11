#!/usr/bin/env node
/**
 * Smoke tests for salah confirmation detection patterns.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Dynamic import compiled path — run after typecheck or use tsx; inline minimal duplicate for CI
const tests = [
  { text: 'ফজর পড়েছি আলহামদুলিল্লাহ', expect: true },
  { text: 'আলহামদুলিল্লাহ, ফজর পড়েছেন', expect: true },
  { text: 'Amk 9 tay remind kore dibe urgent', expect: false },
  { text: 'পড়েছেন কি?', expect: false },
  { text: 'আজকে নামাজের সময় বলো', expect: false },
]

async function main() {
  const mod = await import(pathToFileURL(join(root, 'src/agent/lib/salah-confirm-intent.ts')).href)
  const { detectSalahConfirmation } = mod
  let failed = 0
  for (const { text, expect } of tests) {
    const got = detectSalahConfirmation(text) != null
    if (got !== expect) {
      console.error(`FAIL: "${text}" → ${got}, expected ${expect}`)
      failed++
    }
  }
  if (failed) process.exit(1)
  console.log(`PASS: ${tests.length} salah confirmation intent cases`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
