/**
 * Browser profiles on disk — where a logged-in session survives between visits,
 * and the rules that stop them from eating the VPS.
 *
 * A persistent profile is what makes "log in once" mean anything: without it every
 * session starts anonymous and the owner re-authenticates every single time. With
 * it, Chromium keeps cookies, localStorage and site data in a directory we own.
 *
 * The catch is that those directories only ever grow. Chromium caches aggressively
 * — Cache, Code Cache, GPUCache — and a handful of sites can turn into gigabytes
 * of data nobody asked for, on a 96 GB box that also runs the phone system. So the
 * store is written budget-first:
 *
 *   • profiles are split PER SITE GROUP, never one big shared profile, so a single
 *     site's junk can be dropped without logging the owner out of everything else;
 *   • caches are trimmed before anything is deleted — cache is regenerable, a
 *     login cookie is not, so the cheap fix is always tried first;
 *   • a profile untouched for TTL days is removed outright;
 *   • past the total budget, least-recently-used profiles go until it fits;
 *   • the budget is enforced BEFORE a new profile is created, so the disk cannot
 *     be filled and then apologised for.
 *
 * Everything here is also exposed to the owner as a plain "clear this site" /
 * "clear everything" control — a cleanup he cannot trigger himself is a cleanup he
 * cannot trust.
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

/** Profiles live under the worker's own data dir, never in the repo tree. */
export const PROFILE_ROOT = resolve(
  process.env.BROWSER_PROFILE_ROOT ?? join(process.cwd(), 'data', 'browser-profiles'),
)

/** Total disk all profiles together may use. */
const MAX_TOTAL_MB = Number(process.env.BROWSER_PROFILE_MAX_MB ?? 2048)
/** A profile nobody has used in this many days is not a login worth keeping. */
const TTL_DAYS = Number(process.env.BROWSER_PROFILE_TTL_DAYS ?? 30)

/** Regenerable Chromium data — dropped first, because losing it costs nothing. */
const CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/Service Worker/CacheStorage',
  'Default/DawnCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
  'component_crx_cache',
]

/**
 * A profile key is a directory name, so it must not be able to escape the root.
 * Anything outside [a-z0-9_-] is folded away rather than rejected, so an odd site
 * name still gets a usable profile instead of an error the owner has to decode.
 */
export function normalizeProfileKey(input) {
  const key = String(input ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
  return key || 'default'
}

export function profilePath(key) {
  const dir = resolve(PROFILE_ROOT, normalizeProfileKey(key))
  // Belt and braces: normalizeProfileKey already strips separators, but a path
  // that somehow left the root would be a filesystem bug worth failing loudly on.
  if (!dir.startsWith(PROFILE_ROOT)) throw new Error(`profile path escaped the root: ${key}`)
  return dir
}

async function pathSize(path) {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      total += await pathSize(child)
    } else {
      try {
        total += (await fs.stat(child)).size
      } catch {
        /* vanished mid-walk — it is not taking space either way */
      }
    }
  }
  return total
}

/** Every profile with what it costs and when it was last touched. */
export async function listProfiles() {
  let names
  try {
    names = await fs.readdir(PROFILE_ROOT, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const dir = join(PROFILE_ROOT, entry.name)
    let lastUsedAt = 0
    try {
      lastUsedAt = (await fs.stat(dir)).mtimeMs
    } catch {
      /* keep 0 — an unreadable profile sorts first for removal, which is right */
    }
    out.push({
      key: entry.name,
      bytes: await pathSize(dir),
      lastUsedAt: new Date(lastUsedAt).toISOString(),
      lastUsedMs: lastUsedAt,
    })
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

export async function totalBytes() {
  return (await listProfiles()).reduce((sum, p) => sum + p.bytes, 0)
}

/** Drop the regenerable caches inside one profile. Logins survive this. */
export async function trimProfileCaches(key) {
  const dir = profilePath(key)
  let freed = 0
  for (const relative of CACHE_DIRS) {
    const target = join(dir, relative)
    const size = await pathSize(target)
    if (size === 0) continue
    try {
      await fs.rm(target, { recursive: true, force: true })
      freed += size
    } catch {
      /* in use by a running session — the next pass gets it */
    }
  }
  return freed
}

/** Remove one profile entirely. This DOES log the owner out of that site. */
export async function purgeProfile(key) {
  const dir = profilePath(key)
  const size = await pathSize(dir)
  await fs.rm(dir, { recursive: true, force: true })
  return size
}

export async function purgeAllProfiles() {
  const profiles = await listProfiles()
  let freed = 0
  for (const profile of profiles) freed += await purgeProfile(profile.key)
  return { freed, removed: profiles.map((p) => p.key) }
}

/**
 * Bring disk use back inside the budget, cheapest action first:
 *   1. profiles past their TTL are removed (a stale login is not worth disk),
 *   2. caches are trimmed everywhere (free, keeps every login),
 *   3. only if still over budget, least-recently-used profiles are removed.
 *
 * Returns what it did, so the owner can be told rather than surprised.
 */
export async function enforceProfileBudget() {
  const maxBytes = MAX_TOTAL_MB * 1024 * 1024
  const ttlMs = TTL_DAYS * 24 * 60 * 60 * 1000
  const now = Date.now()
  const report = { expired: [], trimmedBytes: 0, evicted: [], beforeBytes: 0, afterBytes: 0 }

  let profiles = await listProfiles()
  report.beforeBytes = profiles.reduce((s, p) => s + p.bytes, 0)

  // 1) expired
  for (const profile of profiles) {
    if (profile.lastUsedMs && now - profile.lastUsedMs > ttlMs) {
      await purgeProfile(profile.key).catch(() => 0)
      report.expired.push(profile.key)
    }
  }
  if (report.expired.length) profiles = await listProfiles()

  // 2) caches — always worth doing, costs the owner nothing
  let total = profiles.reduce((s, p) => s + p.bytes, 0)
  if (total > maxBytes) {
    for (const profile of profiles) {
      report.trimmedBytes += await trimProfileCaches(profile.key).catch(() => 0)
    }
    profiles = await listProfiles()
    total = profiles.reduce((s, p) => s + p.bytes, 0)
  }

  // 3) least-recently-used, only if the cheap steps were not enough
  if (total > maxBytes) {
    const byAge = [...profiles].sort((a, b) => a.lastUsedMs - b.lastUsedMs)
    for (const profile of byAge) {
      if (total <= maxBytes) break
      await purgeProfile(profile.key).catch(() => 0)
      report.evicted.push(profile.key)
      total -= profile.bytes
    }
  }

  report.afterBytes = await totalBytes()
  return report
}

/**
 * Prepare a profile directory for use, enforcing the budget FIRST so a new login
 * can never be the thing that fills the disk.
 */
export async function ensureProfile(key) {
  const normalized = normalizeProfileKey(key)
  await fs.mkdir(PROFILE_ROOT, { recursive: true })
  const budget = await enforceProfileBudget()
  const dir = profilePath(normalized)
  await fs.mkdir(dir, { recursive: true })
  // Touch it so LRU ordering reflects use, not creation.
  await fs.utimes(dir, new Date(), new Date()).catch(() => {})
  return { key: normalized, dir, budget }
}
