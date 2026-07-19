/**
 * Skill Engine V2 (B4) — VPS runner: fetch a commit-pinned skill package, then hand the
 * files to the server-side scan + lifecycle store (/api/assistant/internal/skill-import).
 * The clone runs on the box (git is on the workbench allowlist); the STATIC safety scan
 * runs server-side. No skill code is ever executed here.
 */
import { fetchPinnedSkillPackage } from './fetch.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/**
 * @param {{repo:string, commit:string, subdir?:string, name:string}} input
 * @returns {Promise<{ok:boolean, id?:string, status?:string, verdict?:string, findings?:any[], error?:string}>}
 */
export async function runSkillImport({ repo, commit, subdir = '', name }) {
  if (!APP_URL() || !INT_TOKEN()) {
    return { ok: false, error: 'APP_URL or AGENT_INTERNAL_TOKEN not set' }
  }
  let pkg
  try {
    pkg = await fetchPinnedSkillPackage({ repo, commit, subdir })
  } catch (err) {
    return { ok: false, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const resolvedName = name || pkg.manifest?.name
  if (!resolvedName) return { ok: false, error: 'skill name missing (no name arg and no manifest.name)' }

  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/skill-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN()}` },
      body: JSON.stringify({
        name: resolvedName,
        sourceRepo: pkg.sourceRepo,
        sourceCommit: pkg.sourceCommit,
        skillMd: pkg.skillMd,
        manifest: pkg.manifest ?? {},
        references: pkg.references,
        scripts: pkg.scripts,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error ?? `bridge HTTP ${res.status}` }
    return { ok: true, ...data }
  } catch (err) {
    return { ok: false, error: `bridge call failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
