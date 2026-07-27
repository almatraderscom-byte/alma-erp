/**
 * SK-8 (item 1) — the owner's approval screen, server side.
 *
 * The ledger has existed since PR #620 with nothing able to write to it. That is
 * why `AGENT_SKILL_APPROVAL_GATE` is still off: switching it on against an empty
 * ledger disables every skill at once, and there was no way to fill it first.
 *
 * Owner-session auth, not the internal worker token, and that is the point
 * rather than a convenience: the ledger records WHO approved a skill, so the
 * approval has to come from him being logged in. A token-authenticated script
 * could write "approvedBy: owner" without the owner being anywhere near it.
 *
 * Read-only GET is safe to call any time; POST does exactly two things —
 * approve the content that is on disk right now, or revoke.
 */
import path from 'path'
import { promises as fs } from 'fs'
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { skillApprovalGateEnabled } from '@/agent/config'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { isSkillEngineEnabled } from '@/agent/lib/skill-engine/enabled'
import { loadApprovalLedger, approveSkill, revokeSkill } from '@/agent/lib/skill-engine/approval-store'
import { buildApprovalView, type SkillApprovalInput } from '@/agent/lib/skill-engine/approval-view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

/**
 * Every skill package on disk, drafts included. The runtime only offers
 * `active`, but the owner has to SEE the drafts — 15 of the 16 originals are
 * draft, and that single fact is what made the skills look broken for weeks.
 */
async function readSkills(): Promise<SkillApprovalInput[]> {
  const index = await discoverSkills(SKILLS_ROOT, { includeDraft: true, includeCanary: true })
  return Promise.all(
    index.skills.map(async (s) => {
      // `isolation` is not part of the discovery metadata (selection never needs
      // it), so read the one field from the manifest. Absent → inline, the same
      // default the runtime uses.
      let isolation: 'inline' | 'subagent' = 'inline'
      try {
        const raw = await fs.readFile(path.join(s.dir, 'manifest.json'), 'utf8')
        if ((JSON.parse(raw) as { isolation?: string }).isolation === 'subagent') isolation = 'subagent'
      } catch {
        /* keep the default — a manifest that fails to parse here already failed discovery */
      }
      return {
        name: s.name,
        version: s.version,
        status: s.status,
        implicit: s.implicit,
        isolation,
        hash: s.hash,
        ...(s.extends ? { extends: s.extends } : {}),
      }
    }),
  )
}

async function view() {
  const [skills, ledger, engineEnabled] = await Promise.all([
    readSkills(),
    loadApprovalLedger(),
    isSkillEngineEnabled(),
  ])
  return buildApprovalView(skills, ledger, { gateOn: skillApprovalGateEnabled(), engineEnabled })
}

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { res: disabled, token: null }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { res: Response.json({ error: 'unauthorized' }, { status: 401 }), token: null }
  if (!isSystemOwner(token)) return { res: Response.json({ error: 'forbidden' }, { status: 403 }), token: null }
  return { res: null, token }
}

export async function GET(req: NextRequest) {
  const { res } = await requireOwner(req)
  if (res) return res
  try {
    return Response.json(await view())
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { res, token } = await requireOwner(req)
  if (res) return res

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    name?: string
    note?: string
    reason?: string
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return Response.json({ error: 'name required' }, { status: 400 })

  try {
    if (body.action === 'approve') {
      // Approve the content that is on disk NOW — never a name alone. The hash is
      // what the gate checks later, so approving by name would mean approving
      // whatever the file happens to say next week.
      const skill = (await readSkills()).find((s) => s.name === name)
      if (!skill) return Response.json({ error: 'unknown skill' }, { status: 404 })
      await approveSkill({
        name: skill.name,
        version: skill.version,
        hash: skill.hash,
        approvedBy: String(token?.name || token?.email || 'owner'),
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined,
      })
    } else if (body.action === 'revoke') {
      // `revoke()` is a no-op on a skill that was never approved. Returning ok
      // there would show a button that appears to work and changes nothing —
      // the exact silent-success shape this codebase keeps getting caught by.
      const ledger = await loadApprovalLedger()
      if (!ledger[name]) return Response.json({ error: 'nothing to revoke — this skill was never approved' }, { status: 409 })
      await revokeSkill({
        name,
        reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined,
      })
    } else {
      return Response.json({ error: 'action must be approve or revoke' }, { status: 400 })
    }
    return Response.json({ ok: true, ...(await view()) })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
