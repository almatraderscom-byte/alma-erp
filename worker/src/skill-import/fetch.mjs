/**
 * Skill Engine V2 (B4) — VPS fetch of a commit-PINNED GitHub skill package.
 *
 * The one piece that needs the box: clone an untrusted repo at an EXACT commit into an
 * ephemeral workspace and read the skill package files. It only FETCHES + reads — it
 * never runs any of the skill's code (import safety is the STATIC scanner on the server,
 * `src/agent/lib/skill-engine/import-scan.ts`). git is on the workbench binary allowlist.
 *
 * Hardening:
 *   • host allowlist (github.com only), commit must be a 40-hex sha (no refs/branches),
 *   • execFile (no shell) so repo/commit strings can't inject,
 *   • shallow fetch of the single pinned commit, size/count caps, always cleaned up.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

const ALLOWED_HOSTS = new Set(['github.com', 'www.github.com'])
const MAX_FILE_BYTES = 64 * 1024
const MAX_REFERENCES = 20
const MAX_SCRIPTS = 20
const GIT_TIMEOUT_MS = 60_000

/** github.com/<owner>/<repo>(.git) → normalized https clone URL, or throw. */
export function validateRepoUrl(repo) {
  let u
  try {
    u = new URL(repo)
  } catch {
    throw new Error(`invalid repo URL: ${repo}`)
  }
  if (u.protocol !== 'https:') throw new Error('repo URL must be https')
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error(`repo host not allowlisted: ${u.hostname}`)
  const parts = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('repo URL must be github.com/<owner>/<repo>')
  if (!/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) throw new Error('bad owner/repo characters')
  return `https://github.com/${parts[0]}/${parts[1]}.git`
}

export function validateCommit(commit) {
  if (!/^[0-9a-f]{40}$/i.test(String(commit ?? ''))) {
    throw new Error('sourceCommit must be a full 40-char commit sha (pinned — no branch/tag)')
  }
  return String(commit).toLowerCase()
}

async function readIfExists(path) {
  try {
    const s = await stat(path)
    if (!s.isFile() || s.size > MAX_FILE_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readDirFiles(dir, cap) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= cap) break
    if (!e.isFile()) continue
    const body = await readIfExists(join(dir, e.name))
    if (body != null) out.push(body)
  }
  return out
}

/**
 * Clone `repo` at exactly `commit`, read `<subdir>/SKILL.md` + manifest.json +
 * references/ + scripts/, and return them for the server-side scanner. Never executes
 * repo code. Always removes the workspace.
 *
 * @returns {Promise<{skillMd:string, manifest:object|null, references:string[], scripts:string[], sourceRepo:string, sourceCommit:string}>}
 */
export async function fetchPinnedSkillPackage({ repo, commit, subdir = '' }) {
  const cloneUrl = validateRepoUrl(repo)
  const sha = validateCommit(commit)
  return _fetchFromResolvedUrl(cloneUrl, sha, subdir)
}

/**
 * The git work, split out so tests can exercise it against a local file:// fixture
 * without the github.com host allowlist. NOT for direct use — go through
 * fetchPinnedSkillPackage so the host + commit validation always runs.
 */
export async function _fetchFromResolvedUrl(cloneUrl, sha, subdir = '') {
  if (subdir && !/^[\w./-]*$/.test(subdir)) throw new Error('bad subdir')
  if (subdir.includes('..')) throw new Error('subdir must not traverse')

  const ws = await mkdtemp(join(tmpdir(), 'alma-skill-import-'))
  try {
    // Shallow, blobless clone then fetch+checkout the single pinned commit. execFile =
    // no shell; args are arrays so the repo/sha can never be interpreted as flags. When a
    // subdir is given, sparse-checkout it so a huge repo only materializes that one folder
    // (blobless + sparse ⇒ only the skill's blobs are ever fetched).
    await run('git', ['init', '--quiet', ws], { timeout: GIT_TIMEOUT_MS })
    await run('git', ['-C', ws, 'remote', 'add', 'origin', cloneUrl], { timeout: GIT_TIMEOUT_MS })
    if (subdir) {
      await run('git', ['-C', ws, 'sparse-checkout', 'init', '--cone'], { timeout: GIT_TIMEOUT_MS })
      await run('git', ['-C', ws, 'sparse-checkout', 'set', subdir], { timeout: GIT_TIMEOUT_MS })
    }
    await run('git', ['-C', ws, 'fetch', '--depth', '1', '--filter=blob:none', 'origin', sha], {
      timeout: GIT_TIMEOUT_MS,
    })
    await run('git', ['-C', ws, 'checkout', '--quiet', sha], { timeout: GIT_TIMEOUT_MS })

    const base = subdir ? join(ws, subdir) : ws
    const skillMd = (await readIfExists(join(base, 'SKILL.md'))) ?? ''
    const manifestRaw = await readIfExists(join(base, 'manifest.json'))
    let manifest = null
    if (manifestRaw) {
      try {
        manifest = JSON.parse(manifestRaw)
      } catch {
        manifest = null
      }
    }
    const references = await readDirFiles(join(base, 'references'), MAX_REFERENCES)
    const scripts = await readDirFiles(join(base, 'scripts'), MAX_SCRIPTS)

    if (!skillMd && !manifest) throw new Error('no SKILL.md or manifest.json found at the pinned path')

    return { skillMd, manifest, references, scripts, sourceRepo: cloneUrl, sourceCommit: sha }
  } finally {
    await rm(ws, { recursive: true, force: true }).catch(() => {})
  }
}
