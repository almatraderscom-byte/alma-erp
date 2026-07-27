/**
 * SK-8 — the durable side of skill provenance.
 *
 * The ledger lives in `agent_kv_settings` under one key, the same place every
 * other owner-tunable switch lives, so approving or revoking a skill needs no
 * migration and no deploy. Rules stay in `provenance.ts` (pure, tested without a
 * database); this file only reads and writes.
 *
 * Fail-open to an EMPTY ledger, never to a permissive one. An empty ledger with
 * the gate on means "nothing is approved yet", which is loud and safe. A KV
 * hiccup that silently approved everything would be the opposite.
 */
import { prisma } from '@/lib/prisma'
import type { SkillApprovalLedger } from '@/agent/lib/skill-engine/provenance'
import { grant, revoke } from '@/agent/lib/skill-engine/provenance'

export const SKILL_APPROVALS_KEY = 'skill_approvals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function loadApprovalLedger(): Promise<SkillApprovalLedger> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: SKILL_APPROVALS_KEY } })
    if (!row?.value) return {}
    const parsed = JSON.parse(String(row.value))
    return parsed && typeof parsed === 'object' ? (parsed as SkillApprovalLedger) : {}
  } catch {
    return {}
  }
}

async function save(ledger: SkillApprovalLedger): Promise<void> {
  const value = JSON.stringify(ledger)
  await db.agentKvSetting.upsert({
    where: { key: SKILL_APPROVALS_KEY },
    create: { key: SKILL_APPROVALS_KEY, value },
    update: { value },
  })
}

/** Approve exactly what is on disk now. `at` is injected so callers stay testable. */
export async function approveSkill(input: {
  name: string
  version: string
  hash: string
  approvedBy: string
  note?: string
  at?: string
}): Promise<SkillApprovalLedger> {
  const ledger = await loadApprovalLedger()
  const next = grant(ledger, { ...input, at: input.at ?? new Date().toISOString() })
  await save(next)
  return next
}

/** The runtime rollback — takes effect on the next turn, no deploy. */
export async function revokeSkill(input: {
  name: string
  reason?: string
  at?: string
}): Promise<SkillApprovalLedger> {
  const ledger = await loadApprovalLedger()
  const next = revoke(ledger, { ...input, at: input.at ?? new Date().toISOString() })
  await save(next)
  return next
}
