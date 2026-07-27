/**
 * SK-8 — the missing half: a way to actually approve a skill.
 *
 * The provenance gate shipped complete except for this. `approveSkill()` existed
 * and had **no caller anywhere in the repo** — no route, no script, no button —
 * so a skill whose files changed after approval was withheld permanently, with
 * no way back short of a deploy. That is what happened: `seo-fixing-own-site`
 * was approved at one content hash, `change_product_slug` was added to its
 * manifest and SKILL.md the next day (#627), the gate correctly read `changed`,
 * and the engine went quiet for every turn afterwards.
 *
 * GET  — every skill on disk with its version, hash and state, plus whether the
 *        gate is even on. This is the screen the owner never had.
 * POST — `{ skill: "<name>" | "all", note?, revoke?, reason? }`. Approving grants
 *        the content that is on disk RIGHT NOW; that is the only thing an
 *        approval can honestly mean.
 *
 * Internal-token only. Approval is recorded as `owner` because the owner is the
 * one who says yes — the token is his.
 */
import { type NextRequest } from 'next/server'
import path from 'path'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyAgentInternalToken, extractBearerToken } from '@/lib/agent-internal-auth'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { approvalState } from '@/agent/lib/skill-engine/provenance'
import { loadApprovalLedger, approveSkill, revokeSkill } from '@/agent/lib/skill-engine/approval-store'
import { skillApprovalGateEnabled } from '@/agent/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

function authed(req: NextRequest): boolean {
  return verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))
}

/** Everything on disk, including drafts — the owner should see what exists, not
 *  only what the runtime currently offers. */
async function snapshot() {
  const index = await discoverSkills(SKILLS_ROOT, { includeCanary: true, includeDraft: true })
  const ledger = await loadApprovalLedger()
  return {
    gateOn: skillApprovalGateEnabled(),
    skills: index.skills.map((s) => {
      const record = ledger[s.name]
      return {
        name: s.name,
        version: s.version,
        status: s.status,
        hash: s.hash,
        state: approvalState({ name: s.name, version: s.version, hash: s.hash }, ledger),
        approvedVersion: record?.version ?? null,
        approvedAt: record?.approvedAt ?? null,
        approvedBy: record?.approvedBy ?? null,
        revokedAt: record?.revokedAt ?? null,
      }
    }),
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authed(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  return Response.json(await snapshot())
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authed(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    skill?: string
    note?: string
    revoke?: boolean
    reason?: string
  }
  const target = (body.skill ?? '').trim()
  if (!target) return Response.json({ error: 'skill required ("<name>" or "all")' }, { status: 400 })

  const index = await discoverSkills(SKILLS_ROOT, { includeCanary: true, includeDraft: true })
  const targets =
    target === 'all'
      // "all" means everything the runtime can actually offer. Approving a draft
      // in bulk would approve skills nobody has read.
      ? index.skills.filter((s) => s.status === 'active')
      : index.skills.filter((s) => s.name === target)

  if (targets.length === 0) {
    return Response.json({ error: 'no such skill on disk', skill: target }, { status: 404 })
  }

  for (const s of targets) {
    if (body.revoke) {
      await revokeSkill({ name: s.name, reason: body.reason })
    } else {
      await approveSkill({
        name: s.name,
        version: s.version,
        // The hash is what is really being approved — the version is a promise a
        // human made, the hash is the content that will run.
        hash: s.hash,
        approvedBy: 'owner',
        note: body.note,
      })
    }
  }

  return Response.json({
    ok: true,
    action: body.revoke ? 'revoked' : 'approved',
    changed: targets.map((s) => s.name),
    ...(await snapshot()),
  })
}
