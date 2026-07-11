/**
 * P4 skill packs — hard verification:
 *   1. Every tool a pack step references EXISTS in the live registry (a tool
 *      rename breaks CI instead of silently breaking the playbook).
 *   2. The completion gate is fail-safe to NOT-done: missing evidence, an
 *      unchecked checklist item, or a thin artifact each block completion AND
 *      leave a P0 checkpoint; only a full report with a real artifact passes
 *      (and passing uploads the proof to storage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const uploaded: Array<{ path: string; bytes: number }> = []
const checkpoints: Array<{ taskRef: string; error?: string }> = []
const artifactRows: Array<{ conversationId: string; type: string }> = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentArtifact: {
      create: vi.fn(async (args: { data: { conversationId: string; type: string } }) => {
        artifactRows.push(args.data)
        return { id: 'art-1' }
      }),
    },
  },
}))
vi.mock('@/agent/lib/storage', () => ({
  agentStorageUpload: vi.fn(async (path: string, buf: Buffer) => {
    uploaded.push({ path, bytes: buf.length })
    return { bucket: 'agent-files', objectPath: path }
  }),
  agentStorageSignedUrl: vi.fn(async (path: string) => `https://signed.example/${path}`),
}))
vi.mock('@/agent/lib/checkpoint', () => ({
  writeCheckpoint: vi.fn(async (input: { taskRef: string; error?: string }) => {
    checkpoints.push({ taskRef: input.taskRef, error: input.error })
    return 'cp-1'
  }),
}))

import { SKILL_PACKS, referencedToolNames } from '@/agent/lib/skill-packs/packs'
import { completeSkillPackRun, findGateMisses, type PackRunReport } from '@/agent/lib/skill-packs/runner'

beforeEach(() => {
  uploaded.length = 0
  checkpoints.length = 0
  artifactRows.length = 0
})

describe('pack protocol integrity', () => {
  it('every referenced tool exists in the live registry', async () => {
    const { TOOLS } = await import('@/agent/tools/registry')
    const registered = new Set(TOOLS.map((t: { name: string }) => t.name))
    const missing = referencedToolNames().filter((n) => !registered.has(n))
    expect(missing, `pack steps reference unregistered tools: ${missing.join(', ')}`).toEqual([])
  }, 30_000) // importing the full tool registry is heavy (~5s cold)

  it('all four packs have required steps, a checklist and an artifact spec', () => {
    for (const pack of Object.values(SKILL_PACKS)) {
      expect(pack.steps.some((s) => s.required)).toBe(true)
      expect(pack.checklist.length).toBeGreaterThan(0)
      expect(pack.guardrails.length).toBeGreaterThan(0)
      expect(pack.artifact.type.length).toBeGreaterThan(0)
    }
  })

  it('spend/publish packs restate the owner-gate guardrail', () => {
    expect(SKILL_PACKS.marketing.guardrails.join(' ')).toMatch(/owner/)
    expect(SKILL_PACKS.website.guardrails.join(' ')).toMatch(/PR-only/)
    expect(SKILL_PACKS.research.guardrails.join(' ')).toMatch(/confirm_oxylabs_spend/)
  })

  it('client_seo audits any site read-only and hands critical/login steps to the owner', () => {
    const pack = SKILL_PACKS.client_seo
    // audit step uses the real audit tools; a mandatory owner-handoff step exists
    const auditStep = pack.steps.find((s) => s.id === 'full-audit')!
    expect(auditStep.required).toBe(true)
    expect(auditStep.tools).toContain('run_website_seo_audit')
    expect(pack.steps.find((s) => s.id === 'owner-handoff')?.required).toBe(true)
    const g = pack.guardrails.join(' ')
    expect(g).toMatch(/login/i)
    expect(g).toMatch(/read-only/i)
    expect(g).toMatch(/CAPTCHA|Password/i)
  })
})

function fullReport(): PackRunReport {
  const pack = SKILL_PACKS.research
  return {
    packKey: 'research',
    conversationId: 'conv-1',
    goal: 'test goal',
    steps: pack.steps.map((s) => ({
      stepId: s.id,
      done: true,
      evidence: `evidence for ${s.id}: found 3 sources, urls recorded, dates checked (long enough).`,
    })),
    checklist: pack.checklist.map(() => true),
    artifactMarkdown: '# রিসার্চ ব্রিফ\n' + 'উত্তর: … claim → source → date …\n'.repeat(20),
  }
}

describe('completion gate — fail-safe to NOT-done', () => {
  it('a full report passes, uploads the artifact and records the row', async () => {
    const res = await completeSkillPackRun(fullReport())
    expect(res.done).toBe(true)
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0].path).toMatch(/^skill-packs\/research\//)
    expect(artifactRows).toHaveLength(1)
    expect(checkpoints).toHaveLength(0)
  })

  it('a missing required step blocks completion and writes a checkpoint', async () => {
    const report = fullReport()
    report.steps = report.steps.filter((s) => s.stepId !== 'cross-check')
    const res = await completeSkillPackRun(report)
    expect(res.done).toBe(false)
    if (!res.done) expect(res.missing.join(' ')).toContain('cross-check')
    expect(checkpoints).toHaveLength(1)
    expect(uploaded).toHaveLength(0)
  })

  it('thin evidence on a required step is not evidence', () => {
    const report = fullReport()
    report.steps[2].evidence = 'ok'
    const misses = findGateMisses(SKILL_PACKS.research, report)
    expect(misses.join(' ')).toContain('no real evidence')
  })

  it('an unchecked checklist item blocks completion', async () => {
    const report = fullReport()
    report.checklist[0] = false
    const res = await completeSkillPackRun(report)
    expect(res.done).toBe(false)
    expect(checkpoints).toHaveLength(1)
  })

  it('a thin artifact blocks completion', () => {
    const report = fullReport()
    report.artifactMarkdown = 'too short'
    const misses = findGateMisses(SKILL_PACKS.research, report)
    expect(misses.join(' ')).toContain('artifact too thin')
  })

  it('an optional step may be skipped ONLY with a reason', () => {
    const report = fullReport()
    const opt = report.steps.find((s) => s.stepId === 'store-knowledge')!
    opt.done = false
    opt.evidence = undefined
    let misses = findGateMisses(SKILL_PACKS.research, report)
    expect(misses.join(' ')).toContain('skipped without a reason')
    opt.skipReason = 'owner said no need to store'
    misses = findGateMisses(SKILL_PACKS.research, report)
    expect(misses).toEqual([])
  })

  it('a failed artifact upload is NOT done (never success without proof)', async () => {
    const storage = await import('@/agent/lib/storage')
    ;(storage.agentStorageUpload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bucket down'))
    const res = await completeSkillPackRun(fullReport())
    expect(res.done).toBe(false)
    if (!res.done) expect(res.missing.join(' ')).toContain('upload failed')
    expect(checkpoints).toHaveLength(1)
  })
})
