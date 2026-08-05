import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  buildOwnerRequirementNote,
  deriveOwnerTurnRequirements,
  requiresLiveToolExecution,
} from '@/agent/lib/owner-turn-requirements'

describe('owner turn requirement contract', () => {
  it('preserves two SEO targets in owner order and requires live browser proof', () => {
    const r = deriveOwnerTurnRequirements(
      'Live browser use kore 1 by 1 full SEO audit + evidence report file: 1= gulshanspaone.com 2= queenspabd.com',
    )
    expect(r.liveBrowser).toBe(true)
    expect(r.clientSeo).toBe(true)
    expect(r.reportArtifact).toBe(true)
    expect(r.targets).toEqual(['https://gulshanspaone.com', 'https://queenspabd.com'])
  })

  it('does not turn an ordinary office question into work requirements', () => {
    expect(deriveOwnerTurnRequirements('Ajker office kemon jacche?')).toEqual({
      liveBrowser: false, clientSeo: false, reportArtifact: false, remember: false, targets: [],
      deepWork: false, planFirst: false, groundingRequired: false,
    })
  })

  // Live miss 2026-07-25 — the owner's plain-English order. reportArtifact used
  // to need the literal word "report"/"file"/"client", so the very turn that
  // ordered a deep audit did not require a deliverable.
  it('an English deep-audit order requires the artifact without the word "report"', () => {
    const r = deriveOwnerTurnRequirements('Do a Deep SEO Audit - almatraders.com')
    expect(r.clientSeo).toBe(true)
    expect(r.reportArtifact).toBe(true)
    expect(r.deepWork).toBe(true)
    expect(r.targets).toEqual(['https://almatraders.com'])
    expect(buildOwnerRequirementNote(r)).toMatch(/client-ready artifact is REQUIRED/)
    expect(buildOwnerRequirementNote(r)).toMatch(/DEEP\/full work/)
  })

  it('marks deep scope words as deep work even without a website target', () => {
    expect(deriveOwnerTurnRequirements('আজকের বিক্রির বিস্তারিত বিশ্লেষণ দাও').deepWork).toBe(true)
    expect(deriveOwnerTurnRequirements('ajker sales koto?').deepWork).toBe(false)
  })

  it('requires a real tool attempt for explicitly named live operational reads', () => {
    expect(requiresLiveToolExecution(
      'Run a full health scan, inspect order issues, and read the audit summary sequentially.',
    )).toBe(true)
    expect(requiresLiveToolExecution('Show the three newest orders with order ID and status.')).toBe(true)
    expect(requiresLiveToolExecution('Explain how health checks generally work.')).toBe(false)
  })
})

describe('BP2 gates (P3 plan-first / P2 grounding) — flag-gated, default no-op', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('stays false when the flags are off (exact current behaviour)', async () => {
    vi.resetModules()
    const { deriveOwnerTurnRequirements: derive } = await import('@/agent/lib/owner-turn-requirements')
    expect(derive('প্রথমে অর্ডার দেখো তারপর প্যাক করো তারপর কুরিয়ারে দাও').planFirst).toBe(false)
    expect(derive('আজকের অর্ডার কত?').groundingRequired).toBe(false)
  })

  it('AGENT_PLAN_GATE=on marks clearly multi-step work, not simple messages', async () => {
    vi.stubEnv('AGENT_PLAN_GATE', 'on')
    vi.resetModules()
    const { deriveOwnerTurnRequirements: derive } = await import('@/agent/lib/owner-turn-requirements')
    expect(derive('প্রথমে অর্ডার দেখো তারপর প্যাক করো তারপর কুরিয়ারে দাও').planFirst).toBe(true)
    expect(derive('make a plan for the eid campaign').planFirst).toBe(true)
    expect(derive('হ্যালো বস').planFirst).toBe(false)
  })

  it('AGENT_GROUNDING_GATE=on marks a live-data question, not a thank-you', async () => {
    vi.stubEnv('AGENT_GROUNDING_GATE', 'on')
    vi.resetModules()
    const { deriveOwnerTurnRequirements: derive } = await import('@/agent/lib/owner-turn-requirements')
    expect(derive('আজকের অর্ডার কত?').groundingRequired).toBe(true)
    expect(derive('how many orders today?').groundingRequired).toBe(true)
    expect(derive('ধন্যবাদ বস').groundingRequired).toBe(false)
  })
})
