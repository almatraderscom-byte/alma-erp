/**
 * Skill Engine V2 (B4) — internal bridge: the VPS worker fetches a commit-pinned skill
 * package (worker/src/skill-import/fetch.mjs) and POSTs the files here. This route runs
 * the STATIC safety scan + records the import into the lifecycle store (quarantined if
 * blocked, else draft — never live without owner promotion). Worker-only (internal token).
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyAgentInternalToken, extractBearerToken } from '@/lib/agent-internal-auth'
import { ingestImportedSkill } from '@/agent/lib/skill-engine/import'
import { prismaImportedSkillStore } from '@/agent/lib/skill-engine/import-store'
import crypto from 'crypto'

export const runtime = 'nodejs'

type Body = {
  name?: string
  sourceRepo?: string
  sourceCommit?: string
  skillMd?: string
  manifest?: Record<string, unknown>
  references?: string[]
  scripts?: string[]
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Body
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const sourceRepo = typeof body.sourceRepo === 'string' ? body.sourceRepo : ''
  const sourceCommit = typeof body.sourceCommit === 'string' ? body.sourceCommit : ''
  if (!name || !sourceRepo || !sourceCommit) {
    return Response.json({ error: 'name, sourceRepo, sourceCommit required' }, { status: 400 })
  }

  // Real Alma tool names → any capability a skill references that isn't one is flagged.
  const { TOOLS } = await import('@/agent/tools/registry')
  const knownCapabilities = new Set(TOOLS.map((t: { name: string }) => t.name))

  try {
    const { record, scan } = await ingestImportedSkill(prismaImportedSkillStore, {
      id: crypto.randomUUID(),
      name,
      sourceRepo,
      sourceCommit,
      skillMd: body.skillMd ?? '',
      manifest: (body.manifest ?? {}) as Body['manifest'] & { name?: string },
      references: Array.isArray(body.references) ? body.references : [],
      scripts: Array.isArray(body.scripts) ? body.scripts : [],
      knownCapabilities,
    })
    return Response.json({
      ok: true,
      id: record.id,
      status: record.status,
      verdict: scan.verdict,
      findings: scan.findings,
      contentHash: scan.contentHash,
    })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'import failed' }, { status: 500 })
  }
}
