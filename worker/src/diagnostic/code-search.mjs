/**
 * READ-ONLY repo grep/read for agent self-diagnosis (runs on VPS with full repo).
 */
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const pexec = promisify(execFile)

const ALLOWED_PREFIXES = ['src/', 'worker/', 'prisma/', 'scripts/']
const DENY_NAME_RE = /\.env|\.pem$|secret|credentials/i

export function getRepoRoot() {
  return process.env.AGENT_REPO_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
}

function normalizeRelPath(file) {
  return String(file).replace(/\\/g, '/').replace(/^\/+/, '')
}

export function isDeniedSourcePath(relPath) {
  const normalized = normalizeRelPath(relPath)
  if (normalized.includes('..')) return true
  const base = path.posix.basename(normalized)
  if (DENY_NAME_RE.test(base) || DENY_NAME_RE.test(normalized)) return true
  return !ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

export function resolveRepoFile(repoRoot, file) {
  const normalized = normalizeRelPath(file)
  if (isDeniedSourcePath(normalized)) return null
  const root = path.resolve(repoRoot)
  const target = path.resolve(root, normalized)
  if (!target.startsWith(root + path.sep) && target !== root) return null
  return target
}

export async function grepRepo(query, repoRoot = getRepoRoot()) {
  if (!query || query.length > 200) return []
  const root = path.resolve(repoRoot)
  try {
    const { stdout } = await pexec(
      'grep',
      ['-rn', '--include=*.ts', '--include=*.tsx', '--include=*.mjs', '--include=*.js', '-e', query, 'src', 'worker'],
      { cwd: root, maxBuffer: 2 * 1024 * 1024 },
    ).catch(err => ({ stdout: err.stdout ?? '' }))
    return String(stdout)
      .split('\n')
      .filter(Boolean)
      .filter(line => !isDeniedSourcePath(line.split(':')[0] ?? ''))
      .slice(0, 40)
  } catch {
    return []
  }
}

export async function readRepoFile(file, repoRoot = getRepoRoot()) {
  const normalized = normalizeRelPath(file)
  const target = resolveRepoFile(repoRoot, normalized)
  if (!target) return { error: 'path out of repo' }
  try {
    const content = await fs.readFile(target, 'utf8')
    return { file: normalized, content: content.slice(0, 12000) }
  } catch {
    return { error: 'read failed' }
  }
}

export async function runCodeSearch(body) {
  if (body.mode === 'grep') {
    return { matches: await grepRepo(String(body.query ?? '')) }
  }
  if (body.mode === 'read') {
    const result = await readRepoFile(String(body.file ?? ''))
    if (result.error) return { error: result.error }
    return result
  }
  return { error: 'bad mode' }
}
