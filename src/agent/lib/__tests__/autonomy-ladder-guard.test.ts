import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Phase 64 — the autonomy ladder is wired into the central guard (GAP-03).
 * Pure map/verdict functions are tested directly; the guard integration proves
 * the exit gate: changing a task class's rung changes the actual guard decision.
 */

vi.mock('@/agent/lib/autonomy-rollout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/lib/autonomy-rollout')>()
  return { ...actual, effectiveStage: vi.fn(async () => ({ stage: 'off' as const, reason: '' })) }
})
vi.mock('@/agent/lib/autonomy-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/lib/autonomy-policy')>()
  return { ...actual, getAutonomyPolicy: vi.fn(async () => ({ enabled: true, moneyCapTaka: 100_000 }) as unknown as Awaited<ReturnType<typeof actual.getAutonomyPolicy>>) }
})

import { taskClassForTool, tierForTaskClass, TASK_FAMILIES } from '@/agent/lib/autonomy-task-catalog'
import { ladderGuardVerdict, ladderEnforcementMode, effectiveStage } from '@/agent/lib/autonomy-rollout'
import { guardToolCall, clearPolicyCache, clearEffectClaims } from '@/agent/lib/policy/tool-guard'
import type { ResolvedClassification } from '@/agent/tools/tool-contract'

const mockedStage = effectiveStage as unknown as ReturnType<typeof vi.fn>

function writeClass(risk: 'low' | 'medium' | 'high' = 'low', domain = 'memory'): ResolvedClassification {
  return {
    domain, mode: 'write', risk,
    approval: 'none', concurrency: 'sequential', idempotency: 'required', proof: 'record',
  } as ResolvedClassification
}

beforeEach(() => {
  clearPolicyCache()
  clearEffectClaims()
  mockedStage.mockResolvedValue({ stage: 'off', reason: '' })
  delete process.env.AGENT_AUTONOMY_LADDER
  delete process.env.VERCEL_ENV
})

describe('taskClassForTool — complete + CI-enforced map (GAP-03)', () => {
  it('every family representative tool resolves back to that family', () => {
    for (const f of TASK_FAMILIES) {
      for (const t of f.representativeTools) {
        expect(taskClassForTool(t).taskClass, `${t} → ${f.id}`).toBe(f.id)
        expect(taskClassForTool(t).tier).toBe(f.tier)
      }
    }
  })

  it('an unknown WRITE tool falls back to a conservative class, never a lax one', () => {
    const high = taskClassForTool('totally_unknown_tool', writeClass('high'))
    expect(high.tier).toBe('R3')
    const noCap = taskClassForTool('totally_unknown_tool')
    expect(noCap.tier).toBe('R3') // cautious when nothing is known
  })

  it('reads map to the read families (R0)', () => {
    expect(taskClassForTool('x', { mode: 'read', risk: 'low', domain: 'research' } as ResolvedClassification).taskClass).toBe('research-public')
    expect(taskClassForTool('x', { mode: 'read', risk: 'low', domain: 'erp' } as ResolvedClassification).tier).toBe('R0')
  })

  it('tierForTaskClass defaults conservatively for an unknown class', () => {
    expect(tierForTaskClass('nonexistent')).toBe('R3')
  })
})

describe('ladderGuardVerdict — rung → decision (pure)', () => {
  it('off/shadow/suggest block, draft stages, auto rungs allow — for agent initiative', () => {
    expect(ladderGuardVerdict('off', 'write', false)).toBe('block')
    expect(ladderGuardVerdict('shadow', 'write', false)).toBe('block')
    expect(ladderGuardVerdict('suggest', 'write', false)).toBe('block')
    expect(ladderGuardVerdict('draft', 'write', false)).toBe('stage')
    expect(ladderGuardVerdict('auto_r1', 'write', false)).toBe('allow')
    expect(ladderGuardVerdict('bounded_r2', 'write', false)).toBe('allow')
  })

  it('owner-direct and reads are never gated by the ladder', () => {
    expect(ladderGuardVerdict('off', 'write', true)).toBe('allow')
    expect(ladderGuardVerdict('off', 'read', false)).toBe('allow')
  })
})

describe('ladderEnforcementMode gate', () => {
  it('off/on/shadow explicit; unset → preview on, prod shadow', () => {
    expect(ladderEnforcementMode('off', 'production')).toBe('off')
    expect(ladderEnforcementMode('on', 'production')).toBe('on')
    expect(ladderEnforcementMode(undefined, 'preview')).toBe('on')
    expect(ladderEnforcementMode(undefined, 'production')).toBe('shadow')
  })
})

describe('guard integration — a rung change changes the guard decision (exit gate)', () => {
  const ctx = { surface: 'owner' as const, turnId: 't1', instructionOrigin: 'model_initiative' as const, confidence: 0.9 }

  it('attaches the ladder task class + stage to the outcome for agent-initiated writes', async () => {
    process.env.AGENT_AUTONOMY_LADDER = 'shadow'
    const out = await guardToolCall('save_memory', {}, writeClass('low'), ctx)
    expect(out.ladderTaskClass).toBe('memory-notes')
    expect(out.ladderStage).toBe('off')
    expect(out.ladderVerdict).toBe('block')
  })

  it('shadow mode does NOT change execution', async () => {
    process.env.AGENT_AUTONOMY_LADDER = 'shadow'
    const shadow = await guardToolCall('save_memory', {}, writeClass('low'), ctx)
    // In shadow the ladder annotates but never flips the base action to a
    // ladder-enforced block.
    expect(shadow.ladderEnforced).toBeUndefined()
  })

  it('ON + stage off blocks the agent-initiated write via the ladder', async () => {
    process.env.AGENT_AUTONOMY_LADDER = 'on'
    mockedStage.mockResolvedValue({ stage: 'off', reason: '' })
    const out = await guardToolCall('save_memory', {}, writeClass('low'), { ...ctx, turnId: 't2' })
    expect(out.action).toBe('block')
    expect(out.ladderEnforced).toBe(true)
  })

  it('ON + stage auto_r1 does NOT ladder-block (rung change flips the decision)', async () => {
    process.env.AGENT_AUTONOMY_LADDER = 'on'
    mockedStage.mockResolvedValue({ stage: 'auto_r1', reason: '' })
    const out = await guardToolCall('save_memory', {}, writeClass('low'), { ...ctx, turnId: 't3' })
    // The ladder allows it; whatever the base decided, it was not a ladder block.
    expect(out.ladderEnforced).toBeUndefined()
    expect(out.ladderVerdict).toBe('allow')
  })

  it('owner-direct writes are never ladder-gated even at stage off', async () => {
    process.env.AGENT_AUTONOMY_LADDER = 'on'
    mockedStage.mockResolvedValue({ stage: 'off', reason: '' })
    const out = await guardToolCall('save_memory', {}, writeClass('low'), {
      surface: 'owner', turnId: 't4', instructionOrigin: 'owner_direct',
    })
    expect(out.ladderEnforced).toBeUndefined()
    expect(out.ladderTaskClass).toBeUndefined() // ladder not even consulted
  })
})
