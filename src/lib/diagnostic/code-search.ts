import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'

const pexec = promisify(execFile)

const ALLOWED_PREFIXES = ['src/', 'worker/', 'prisma/', 'scripts/']
const DENY_NAME_RE = /\.env|\.pem$|secret|credentials/i

export function getRepoRoot(): string {
  return process.env.AGENT_REPO_PATH || process.cwd()
}

function normalizeRelPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function isDeniedSourcePath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath)
  if (normalized.includes('..')) return true
  const base = path.posix.basename(normalized)
  if (DENY_NAME_RE.test(base) || DENY_NAME_RE.test(normalized)) return true
  return !ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

export function resolveRepoFile(repoRoot: string, file: string): string | null {
  const normalized = normalizeRelPath(file)
  if (isDeniedSourcePath(normalized)) return null
  const root = path.resolve(repoRoot)
  const target = path.resolve(root, normalized)
  if (!target.startsWith(root + path.sep) && target !== root) return null
  return target
}

export async function grepRepo(query: string, repoRoot = getRepoRoot()): Promise<string[]> {
  if (!query || query.length > 200) return []
  const root = path.resolve(repoRoot)
  try {
    const { stdout } = await pexec(
      'grep',
      ['-rn', '--include=*.ts', '--include=*.tsx', '--include=*.mjs', '--include=*.js', '-e', query, 'src', 'worker'],
      { cwd: root, maxBuffer: 2 * 1024 * 1024 },
    ).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }))
    return String(stdout)
      .split('\n')
      .filter(Boolean)
      .filter(line => !isDeniedSourcePath(line.split(':')[0] ?? ''))
      .slice(0, 40)
  } catch {
    return []
  }
}

export async function readRepoFile(
  file: string,
  repoRoot = getRepoRoot(),
): Promise<{ file: string; content: string } | { error: string }> {
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

export type CodeSearchBody = { mode: 'grep' | 'read'; query?: string; file?: string }

export async function runCodeSearch(body: CodeSearchBody, repoRoot = getRepoRoot()) {
  if (body.mode === 'grep') {
    const matches = await grepRepo(String(body.query ?? ''), repoRoot)
    return { matches }
  }
  if (body.mode === 'read') {
    const result = await readRepoFile(String(body.file ?? ''), repoRoot)
    if ('error' in result) return { error: result.error }
    return result
  }
  return { error: 'bad mode' }
}
