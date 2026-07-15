/**
 * LG-4 shadow turn graph — offline behaviour lock.
 *
 * Contracts: gate discipline; the pure fast-path classifier mirrors the head
 * router's check ORDER (deny beats marketing beats routine); agreement is only
 * scored where deterministic (deny/call/marketing/routine and never on pinned
 * turns); the runner is fail-open. prisma-free by construction — every node is
 * pure. classifyHeadFastPath runs for real (head-router import), so this suite
 * also locks classifier↔router regex parity at the module level.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { classifyHeadFastPath } from '@/agent/lib/models/head-router'
import {
  isTurnGraphShadowEnabled,
  runTurnGraphShadow,
  type TurnGraphShadowInput,
} from '../turn-graph-shadow'

const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ['AGENT_LANGGRAPH_TURN', 'VERCEL_ENV']) savedEnv[k] = process.env[k]
  process.env.AGENT_LANGGRAPH_TURN = 'shadow'
})
afterEach(() => {
  for (const k of ['AGENT_LANGGRAPH_TURN', 'VERCEL_ENV']) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function input(over: Partial<TurnGraphShadowInput> = {}): TurnGraphShadowInput {
  return {
    lastUserText: 'aj koto sale holo',
    headTier: 'light',
    headVia: 'routine_kw',
    listenMode: false,
    toolGroups: ['erp_reads'],
    toolCount: 12,
    toolRouter: 'state',
    maxIterations: 12,
    ...over,
  }
}

describe('isTurnGraphShadowEnabled', () => {
  it('kill switch / force / preview default / production default', () => {
    delete process.env.AGENT_LANGGRAPH_TURN // undefined arg must test the real default
    expect(isTurnGraphShadowEnabled('false', 'preview')).toBe(false)
    expect(isTurnGraphShadowEnabled('shadow', 'production')).toBe(true)
    expect(isTurnGraphShadowEnabled('true', 'production')).toBe(true)
    expect(isTurnGraphShadowEnabled(undefined, 'preview')).toBe(true)
    expect(isTurnGraphShadowEnabled(undefined, 'production')).toBe(false)
  })
})

describe('classifyHeadFastPath (order parity with the head router)', () => {
  it.each([
    ['salary ta refund koro', 'deny_kw'], // deny wins over everything
    ['aj koto sale holo', 'routine_kw'],
    ['fb te post banao', 'marketing_kw'],
    ['ok', 'continuation'],
  ] as const)('"%s" → %s', (text, kind) => {
    expect(classifyHeadFastPath(text)).toBe(kind)
  })

  it('deny beats marketing when both match', () => {
    expect(classifyHeadFastPath('ad budget refund koro campaign er')).toBe('deny_kw')
  })

  it('long non-matching text → null (triage territory)', () => {
    expect(
      classifyHeadFastPath('ei quarter er growth strategy niye tomar bishleshon dorkar, details e bolo'),
    ).toBeNull()
  })
})

describe('runTurnGraphShadow', () => {
  it('agreement on a routine fast-path turn', async () => {
    const r = await runTurnGraphShadow(input())
    expect(r).not.toBeNull()
    expect(r!.mode).toBe('shadow')
    expect(r!.fastPath).toBe('routine_kw')
    expect(r!.agree).toBe(true)
    expect(r!.legacyTier).toBe('light')
  })

  it('MISMATCH: graph says deny but live turn ran cheap', async () => {
    const r = await runTurnGraphShadow(
      input({ lastUserText: 'salary refund koro', headVia: 'routine_kw', headTier: 'light' }),
    )
    expect(r!.fastPath).toBe('deny_kw')
    expect(r!.agree).toBe(false)
  })

  it('pinned (explicit) turns are recorded but never scored', async () => {
    const r = await runTurnGraphShadow(
      input({ headTier: 'explicit', headVia: 'explicit', lastUserText: 'salary refund koro' }),
    )
    expect(r!.fastPath).toBe('deny_kw')
    expect(r!.agree).toBeNull()
  })

  it('hint/DB-dependent kinds are recorded, not judged', async () => {
    const r = await runTurnGraphShadow(input({ lastUserText: 'ok', headVia: 'sticky_thread' }))
    expect(r!.fastPath).toBe('continuation')
    expect(r!.agree).toBeNull()
  })

  it('gate off → null', async () => {
    process.env.AGENT_LANGGRAPH_TURN = 'false'
    expect(await runTurnGraphShadow(input())).toBeNull()
  })
})
