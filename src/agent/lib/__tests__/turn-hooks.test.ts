import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  registerPreToolHook,
  registerPostToolHook,
  clearTurnHooks,
  runPreToolHooks,
  runPostToolHooks,
  turnHooksEnabled,
} from '../turn-hooks'

const ctx = {
  toolName: 'get_orders',
  input: { limit: 5 },
  model: 'claude-sonnet-4-6',
  personalMode: false,
  businessId: 'ALMA_LIFESTYLE',
}

describe('turn-hooks (harness gap 2)', () => {
  beforeEach(() => clearTurnHooks())
  afterEach(() => {
    clearTurnHooks()
    delete process.env.AGENT_TURN_HOOKS
  })

  it('default ON; empty registry allows everything (no-op)', () => {
    expect(turnHooksEnabled()).toBe(true)
    expect(runPreToolHooks(ctx)).toEqual({ action: 'allow' })
  })

  it('kill switch AGENT_TURN_HOOKS=false bypasses registered hooks', () => {
    registerPreToolHook({ name: 'deny-all', run: () => ({ action: 'block', message: 'no' }) })
    process.env.AGENT_TURN_HOOKS = 'false'
    expect(runPreToolHooks(ctx)).toEqual({ action: 'allow' })
  })

  it('first blocking pre-hook wins and short-circuits', () => {
    const order: string[] = []
    registerPreToolHook({ name: 'a', run: () => { order.push('a'); return { action: 'allow' } } })
    registerPreToolHook({ name: 'b', run: () => { order.push('b'); return { action: 'block', message: 'blocked by b' } } })
    registerPreToolHook({ name: 'c', run: () => { order.push('c'); return { action: 'allow' } } })
    const decision = runPreToolHooks(ctx)
    expect(decision).toEqual({ action: 'block', message: 'blocked by b' })
    expect(order).toEqual(['a', 'b'])
  })

  it('a throwing pre-hook is skipped (fail-open) and later hooks still run', () => {
    registerPreToolHook({ name: 'boom', run: () => { throw new Error('hook bug') } })
    registerPreToolHook({ name: 'ok', run: () => ({ action: 'block', message: 'still reached' }) })
    expect(runPreToolHooks(ctx)).toEqual({ action: 'block', message: 'still reached' })
  })

  it('duplicate hook names register once', () => {
    let calls = 0
    registerPreToolHook({ name: 'dup', run: () => { calls++; return { action: 'allow' } } })
    registerPreToolHook({ name: 'dup', run: () => { calls++; return { action: 'allow' } } })
    runPreToolHooks(ctx)
    expect(calls).toBe(1)
  })

  it('post-hooks observe outcome; a throwing post-hook is swallowed', () => {
    const seen: Array<{ tool: string; success: boolean }> = []
    registerPostToolHook({ name: 'boom', run: () => { throw new Error('post bug') } })
    registerPostToolHook({
      name: 'audit',
      run: (c) => { seen.push({ tool: c.toolName, success: c.success }) },
    })
    expect(() =>
      runPostToolHooks({ ...ctx, success: false, error: 'x', durationMs: 12 }),
    ).not.toThrow()
    expect(seen).toEqual([{ tool: 'get_orders', success: false }])
  })
})
