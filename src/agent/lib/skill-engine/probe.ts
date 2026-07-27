/**
 * Skill Engine V2 — the measurement, shared by the two routes that take it.
 *
 * Round one (PR #630) asked "are the SKILL.md packages on disk in the deployed
 * lambda?" and the answer, from production, was **yes**: 20 directories, 5 active
 * skills discovered, no warnings, and `website er seo fix koro` routes to
 * `seo-fixing-own-site` by rule. So the bundling theory was wrong.
 *
 * Which leaves the harder question. A real production turn — with an OWNER pin
 * written straight into the conversation row — still emitted no `skill_pinned`.
 * Discovery works in the PROBE's lambda; the turn runs in the CHAT lambda, and
 * they are separate bundles with separate traced files. So the measurement has
 * to run where the turn runs, and it has to call the same function the turn
 * calls — `buildActiveSkills` — not a lookalike.
 *
 * Read-only, internal-token gated, no model call.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { routeSkill } from '@/agent/lib/skill-engine/router'
import { isSkillEngineEnabled } from '@/agent/lib/skill-engine/enabled'

export interface SkillProbeResult {
  enabled: boolean
  cwd: string
  root: string
  readdirError: string | null
  dirCount: number
  dirs: string[]
  files: Record<string, string[]>
  discovered: Array<{ name: string; version: string; status: string }>
  warnings: string[]
  probe: string | null
  route: unknown
  /** What `buildActiveSkills` — the function the live turn calls — returns here. */
  active?: {
    pinned: unknown
    blockChars: number
    manifest: string | null
    isolated: boolean
    error?: string
  }
}

export async function skillDiskSnapshot(
  opts: { probe?: string | null; conversationId?: string | null; includeActive?: boolean } = {},
): Promise<SkillProbeResult> {
  const cwd = process.cwd()
  const root = path.join(cwd, 'src', 'agent', 'skills')

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
    skills: [] as Awaited<ReturnType<typeof discoverSkills>>['skills'],
    warnings: [`discover threw: ${err instanceof Error ? err.message : String(err)}`],
  }))

  const probe = opts.probe ?? null
  const result: SkillProbeResult = {
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
    route: probe ? routeSkill(index, probe) : null,
  }

  // The real call, with the real conversation id. `buildActiveSkills` swallows
  // every error by design (a skill hiccup must never break a turn) — which is
  // exactly why the failure has been invisible. Here the swallowed error is the
  // answer, so it is reported rather than hidden.
  if (opts.includeActive && probe) {
    try {
      const { buildActiveSkills } = await import('@/agent/lib/skill-engine/runtime')
      const active = await buildActiveSkills(probe, {
        conversationId: opts.conversationId ?? undefined,
      })
      result.active = {
        pinned: active.pinned,
        blockChars: active.block.length,
        manifest: active.manifest?.name ?? null,
        isolated: Boolean(active.isolated),
      }
    } catch (err) {
      result.active = {
        pinned: null,
        blockChars: 0,
        manifest: null,
        isolated: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      }
    }
  }

  return result
}
