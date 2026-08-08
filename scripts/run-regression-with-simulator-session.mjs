#!/usr/bin/env node
/**
 * Runs a Node regression script with the authenticated iOS Simulator session.
 * The session value is kept in-memory and is never printed or written to disk.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (!args.length) {
  console.error('Usage: node scripts/run-regression-with-simulator-session.mjs <script> [args...]')
  process.exit(2)
}

const udid = process.env.REGRESSION_SIMULATOR_UDID || '94E0186B-5CDA-4708-9368-53B4FF7274E7'
const bundleId = process.env.REGRESSION_IOS_BUNDLE_ID || 'com.almatraders.erp'
const targetHost = new URL(process.env.REGRESSION_BASE_URL || 'https://alma-erp-six.vercel.app').hostname

function cString(buffer, start, end) {
  if (start < 0 || start >= end) return ''
  const zero = buffer.indexOf(0, start)
  return buffer.toString('utf8', start, zero >= start && zero < end ? zero : end)
}

function parseBinaryCookies(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'cook') throw new Error('Unexpected binary cookie format')
  const pageCount = buffer.readUInt32BE(4)
  const pageSizes = []
  for (let i = 0; i < pageCount; i += 1) pageSizes.push(buffer.readUInt32BE(8 + (i * 4)))

  const cookies = []
  let pageStart = 8 + (pageCount * 4)
  for (const pageSize of pageSizes) {
    const pageEnd = pageStart + pageSize
    if (pageEnd > buffer.length || pageSize < 8) break
    const count = buffer.readUInt32LE(pageStart + 4)
    for (let i = 0; i < count; i += 1) {
      const relative = buffer.readUInt32LE(pageStart + 8 + (i * 4))
      const start = pageStart + relative
      if (start + 32 > pageEnd) continue
      const size = buffer.readUInt32LE(start)
      const end = Math.min(start + size, pageEnd)
      const domainOffset = buffer.readUInt32LE(start + 16)
      const nameOffset = buffer.readUInt32LE(start + 20)
      const pathOffset = buffer.readUInt32LE(start + 24)
      const valueOffset = buffer.readUInt32LE(start + 28)
      cookies.push({
        domain: cString(buffer, start + domainOffset, end),
        name: cString(buffer, start + nameOffset, end),
        path: cString(buffer, start + pathOffset, end),
        value: cString(buffer, start + valueOffset, end),
      })
    }
    pageStart = pageEnd
  }
  return cookies
}

try {
  const appData = execFileSync(
    'xcrun',
    ['simctl', 'get_app_container', udid, bundleId, 'data'],
    { encoding: 'utf8' },
  ).trim()
  const cookieFile = join(appData, 'Library', 'Cookies', `${bundleId}.binarycookies`)
  const cookies = parseBinaryCookies(readFileSync(cookieFile))
  const session = cookies.find((cookie) =>
    cookie.name.includes('next-auth.session-token')
    && (targetHost.endsWith(cookie.domain.replace(/^\./, '')) || cookie.domain.includes(targetHost)),
  )
  if (!session?.value) throw new Error(`No active ${targetHost} session cookie found in the simulator`)

  console.log(`[auth] Using in-memory iPhone Simulator session for ${targetHost}; secret not logged`)
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, REGRESSION_COOKIE: `${session.name}=${session.value}` },
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
} catch (error) {
  console.error(`[FAIL] simulator_session — ${error?.message || String(error)}`)
  process.exit(1)
}
