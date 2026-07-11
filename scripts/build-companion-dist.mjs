/**
 * Publish the ALMA Companion extension WITH the site (owner request 2026-07-11:
 * two Macs kept drifting to different extension versions).
 *
 * Runs inside `npm run build` (so every main merge → Vercel deploy republishes):
 *   public/companion/…              — the extension files, served statically
 *   public/companion-version.json   — { version, files[] } (updater + the
 *                                     extension's own update check read this)
 *   public/companion-updater.sh     — the per-machine updater/installer script
 *
 * Each Mac/PC runs companion-updater.sh from launchd/Task Scheduler; it syncs
 * the served files into the local unpacked-extension folder, and the extension
 * reloads itself when it sees a newer version on disk. No manual copying.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = 'extension/alma-companion'
const DEST = 'public/companion'

function listFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base))
    else out.push(relative(base, p))
  }
  return out
}

if (!existsSync(SRC)) {
  console.log('[companion-dist] extension source missing — skipped')
  process.exit(0)
}

rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })
cpSync(SRC, DEST, { recursive: true })

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
const files = listFiles(SRC).sort()
writeFileSync(
  'public/companion-version.json',
  JSON.stringify({ version: manifest.version, files, publishedAt: new Date().toISOString() }, null, 2),
)
cpSync('scripts/companion-updater.sh', 'public/companion-updater.sh')
console.log(`[companion-dist] published v${manifest.version} (${files.length} files) → public/companion`)
