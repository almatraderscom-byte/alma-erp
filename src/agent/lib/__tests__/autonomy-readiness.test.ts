/**
 * Phase 51 exit gates, as executable tests:
 *   1. Every executable tool has an owner-readable readiness row; unknown ≠ ready.
 *   2. Every off-by-default flag lists prerequisites + rollback (never a date).
 *   3. The autonomy fixture corpus is ≥200 valid, PII-scrubbed cases covering
 *      all twelve scenario classes, consistent with the constitutional rules.
 *   4. The baseline replay runs and reports honestly (no hidden thresholds).
 */
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, getCapability } from '@/agent/tools/capability-manifest'
import {
  AUTONOMY_METRICS,
  FLAG_REGISTRY,
  RISK_LADDER,
  TASK_FAMILIES,
  buildToolReadinessMap,
  deriveTier,
  summarizeReadiness,
} from '@/agent/lib/autonomy-task-catalog'
import {
  AUTONOMY_CASE_CLASSES,
  expectedDecision,
  loadAutonomyFixtures,
  runAutonomyReplay,
} from '@/agent/replay/run-autonomy-replay'

describe('risk ladder + task families', () => {
  it('defines all five tiers exactly once', () => {
    expect(RISK_LADDER.map((t) => t.tier)).toEqual(['R0', 'R1', 'R2', 'R3', 'R4'])
  })

  it('every task family representative tool exists in the manifest (money-movement has none on purpose)', () => {
    for (const f of TASK_FAMILIES) {
      if (f.id === 'money-movement') {
        expect(f.representativeTools).toHaveLength(0)
        expect(f.authority).toBe('owner_only')
        continue
      }
      expect(f.representativeTools.length).toBeGreaterThan(0)
      for (const t of f.representativeTools) {
        expect(getCapability(t), `task family ${f.id} references unknown tool ${t}`).toBeDefined()
      }
    }
  })

  it('R3/R4 families are never authorized below point-of-risk', () => {
    for (const f of TASK_FAMILIES) {
      if (f.tier === 'R3') expect(['point_of_risk', 'owner_only']).toContain(f.authority)
      if (f.tier === 'R4') expect(f.authority).toBe('owner_only')
    }
  })
})

describe('tool readiness map (exit gate 1)', () => {
  const rows = buildToolReadinessMap()
  const byTool = new Map(rows.map((r) => [r.tool, r]))

  it('covers 100% of executable tools', () => {
    for (const cap of CAPABILITIES) {
      expect(byTool.has(cap.name), `no readiness row for ${cap.name}`).toBe(true)
    }
    expect(summarizeReadiness(rows).writeToolsWithoutRow).toEqual([])
  })

  it('only pure reads may be "ready" at baseline — no write is ready before the guard kernel exists', () => {
    for (const r of rows) {
      if (r.readiness === 'ready') expect(r.tier).toBe('R0')
      if (r.mode !== 'read') expect(['partial', 'not_ready']).toContain(r.readiness)
    }
  })

  it('honest baseline: idempotency/proof are declared but NOT enforced anywhere yet', () => {
    for (const r of rows) {
      expect(r.idempotencyEnforced).toBe(false)
      expect(r.proofEnforced).toBe(false)
    }
  })

  it('tier derivation matches the risk ladder', () => {
    expect(deriveTier({ mode: 'read', risk: 'high', domain: 'erp' })).toBe('R0')
    expect(deriveTier({ mode: 'write', risk: 'high', domain: 'autonomy' })).toBe('R4')
    expect(deriveTier({ mode: 'write', risk: 'high', domain: 'wa' })).toBe('R3')
    expect(deriveTier({ mode: 'stage', risk: 'low', domain: 'staff' })).toBe('R1')
    expect(deriveTier({ mode: 'write', risk: 'low', domain: 'todo' })).toBe('R1')
    expect(deriveTier({ mode: 'stage', risk: 'medium', domain: 'growth' })).toBe('R2')
  })
})

describe('flag registry (exit gate 2)', () => {
  it('every flag lists at least one prerequisite and a concrete rollback', () => {
    expect(FLAG_REGISTRY.length).toBeGreaterThanOrEqual(8)
    for (const f of FLAG_REGISTRY) {
      expect(f.prerequisites.length, `${f.flag} needs prerequisites`).toBeGreaterThan(0)
      expect(f.rollback.length, `${f.flag} needs rollback`).toBeGreaterThan(10)
    }
  })

  it('prerequisites are gates, not proposed dates', () => {
    for (const f of FLAG_REGISTRY) {
      for (const p of f.prerequisites) {
        expect(p, `${f.flag} prerequisite looks like a date promise: "${p}"`).not.toMatch(/\b20\d{2}\b|\bQ[1-4]\b|\bnext (week|month)\b/i)
      }
    }
  })
})

describe('autonomy fixture corpus (exit gate 3)', () => {
  const { cases, errors } = loadAutonomyFixtures()

  it('loads with zero validation errors', () => {
    expect(errors).toEqual([])
  })

  it('has at least 200 cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(200)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
  })

  it('covers all twelve scenario classes with meaningful volume', () => {
    const byClass = new Map<string, number>()
    for (const c of cases) byClass.set(c.class, (byClass.get(c.class) ?? 0) + 1)
    for (const cls of AUTONOMY_CASE_CLASSES) {
      expect(byClass.get(cls) ?? 0, `class ${cls} underrepresented`).toBeGreaterThanOrEqual(10)
    }
  })

  it('every case tool exists in the manifest with matching classification', () => {
    for (const c of cases) {
      const cap = getCapability(c.tool)
      expect(cap, `${c.id}: unknown tool ${c.tool}`).toBeDefined()
      expect(cap!.mode, `${c.id}: mode drift`).toBe(c.toolMode)
      expect(cap!.risk, `${c.id}: risk drift`).toBe(c.toolRisk)
    }
  })

  it('authored expectations match the constitutional rules exactly', () => {
    for (const c of cases) {
      const exp = expectedDecision(c)
      expect(`${c.id}:${exp.decision}`, `${c.id} expected ${c.expected.decision} (${c.expected.reasonClass})`).toBe(`${c.id}:${c.expected.decision}`)
    }
  })

  it('the corpus is not trivially permissive — every decision kind appears', () => {
    const decisions = new Set(cases.map((c) => c.expected.decision))
    expect(decisions).toEqual(new Set(['allow', 'stage', 'deny']))
    const denies = cases.filter((c) => c.expected.decision === 'deny').length
    expect(denies).toBeGreaterThanOrEqual(50)
  })

  it('no R3/R4 case expects silent auto-execution from non-owner instruction', () => {
    for (const c of cases) {
      const cap = getCapability(c.tool)!
      const tier = deriveTier(cap)
      if ((tier === 'R3' || tier === 'R4') && c.context.instructionOrigin !== 'owner_direct') {
        expect(c.expected.decision, `${c.id} would auto-fire ${tier}`).not.toBe('allow')
      }
    }
  })
})

describe('baseline replay (exit gate 4 — honest numbers)', () => {
  it('runs clean and reports the real baseline gap without hiding it', () => {
    const report = runAutonomyReplay()
    expect(report.fixtureErrors).toEqual([])
    expect(report.integrityErrors).toEqual([])
    expect(report.expectationErrors).toEqual([])
    expect(report.totalCases).toBeGreaterThanOrEqual(200)
    expect(report.baselineAccuracy).toBeGreaterThan(0)
    expect(report.baselineAccuracy).toBeLessThanOrEqual(1)
    // The audit found no universal guard — a perfect baseline would mean the
    // corpus is too easy or the baseline model is dishonest. Phase 52 must
    // close this gap against the REAL guard, not this approximation.
    expect(report.baselineAccuracy, 'baseline claims 100% — corpus or baseline model is dishonest').toBeLessThan(1)
    expect(report.mismatches.length).toBe(report.totalCases - Math.round(report.baselineAccuracy * report.totalCases))
  })

  it('metric definitions stay honest: unmeasured is reported as unmeasured, not zero-risk', () => {
    for (const m of AUTONOMY_METRICS) {
      expect(m.definition.length).toBeGreaterThan(20)
      expect(m.source.length).toBeGreaterThan(5)
      expect(m.baseline === 'unmeasured' || (typeof m.baseline === 'number' && m.baseline >= 0 && m.baseline <= 1)).toBe(true)
    }
  })
})
