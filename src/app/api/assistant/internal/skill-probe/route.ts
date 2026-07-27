/**
 * Skill Engine V2 — a diagnostic, not a feature.
 *
 * Live finding 2026-07-27: with the engine switched ON in production and an
 * OWNER pin written straight into `agent_conversations.pinned_skill`, a real
 * production turn still emitted no `skill_pinned` event. Reading the code, that
 * is only possible one way: `buildActiveSkills` resolves the pin, then filters
 * the on-disk index by that name and finds nothing, so it returns "no skills".
 * In other words the engine is switched on and doing nothing, silently, because
 * every path in it is fail-open.
 *
 * The one thing no test can answer is what is actually ON DISK inside the
 * deployed lambda. This route answers exactly that and nothing else: it lists
 * the skills directory, runs discovery, and (optionally) routes a probe text.
 * Internal-token only, read-only, no model call, no cost.
 *
 * It carries its own `outputFileTracingIncludes` entry in next.config.js — a
 * probe that traced the files differently from the chat route would answer a
 * question nobody asked.
 */
import { type NextRequest } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyAgentInternalToken, extractBearerToken } from '@/lib/agent-internal-auth'
import { isSkillEngineEnabled } from '@/agent/lib/skill-engine/enabled'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { routeSkill } from '@/agent/lib/skill-engine/router'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const cwd = process.cwd()
  const root = path.join(cwd, 'src', 'agent', 'skills')

  // What the filesystem says — the question the whole diagnostic exists for.
  let dirs: string[] = []
  let readdirError: string | null = null
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (err) {
    readdirError = err instanceof Error ? err.message : String(err)
  }

  // Files matter, not just folders: a traced directory with no manifest.json
  // discovers as zero skills and looks exactly like a missing directory.
  const files: Record<string, string[]> = {}
  for (const d of dirs.slice(0, 30)) {
    try {
      files[d] = await fs.readdir(path.join(root, d))
    } catch {
      files[d] = ['<unreadable>']
    }
  }

  const index = await discoverSkills(root).catch((err) => ({
    skills: [],
    warnings: [`discover threw: ${err instanceof Error ? err.message : String(err)}`],
  }))

  const probe = req.nextUrl.searchParams.get('probe')
  const route = probe ? routeSkill(index, probe) : null

  return Response.json({
    enabled: await isSkillEngineEnabled(),
    cwd,
    root,
    readdirError,
    dirCount: dirs.length,
    dirs,
    files,
    discovered: index.skills.map((s) => ({ name: s.name, version: s.version, status: s.status })),
    warnings: index.warnings,
    probe,
    route,
  })
}
