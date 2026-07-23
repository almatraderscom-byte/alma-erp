import { describe, it, expect, afterEach } from 'vitest'
import {
  contextCompilerMode,
  shadowCompileOwnerContext,
  STABLE_CORE_TOKEN_BUDGET,
  INITIAL_REQUEST_TOKEN_BUDGET,
} from '../context-compile-shadow'

const OLD = process.env.AGENT_CONTEXT_COMPILER
afterEach(() => {
  if (OLD === undefined) delete process.env.AGENT_CONTEXT_COMPILER
  else process.env.AGENT_CONTEXT_COMPILER = OLD
})

describe('context-compiler shadow (P1-1)', () => {
  it('defaults to shadow; off/0/false disables', () => {
    delete process.env.AGENT_CONTEXT_COMPILER
    expect(contextCompilerMode()).toBe('shadow')
    process.env.AGENT_CONTEXT_COMPILER = 'off'
    expect(contextCompilerMode()).toBe('off')
    process.env.AGENT_CONTEXT_COMPILER = 'false'
    expect(contextCompilerMode()).toBe('off')
  })

  it('is deterministic and records full provenance', () => {
    const input = {
      stableBlocks: ['constitution text', 'skills text'],
      volatileText: 'workflow snapshot',
      requestText: 'ajker sales?',
    }
    const a = shadowCompileOwnerContext(input)
    const b = shadowCompileOwnerContext(input)
    expect(a.compiled.text).toBe(b.compiled.text)
    expect(a.compiled.provenance.map((p) => p.kind)).toEqual([
      'constitution',
      'skill',
      'workflow_state',
      'request_suffix',
    ])
    expect(a.stableTokens).toBe(a.compiled.cacheablePrefixTokens)
    expect(a.initialRequestTokens).toBe(a.compiled.totalTokens)
  })

  it('flags budget breaches instead of hiding them', () => {
    const big = 'x'.repeat(STABLE_CORE_TOKEN_BUDGET * 8) // ≫ 5k tokens
    const r = shadowCompileOwnerContext({ stableBlocks: [big], volatileText: '', requestText: 'q' })
    expect(r.stableWithinBudget).toBe(false)
    expect(r.initialWithinBudget).toBe(r.initialRequestTokens <= INITIAL_REQUEST_TOKEN_BUDGET)
  })

  it('drops empty segments (no phantom bundles)', () => {
    const r = shadowCompileOwnerContext({ stableBlocks: ['core', '  '], volatileText: '', requestText: '' })
    expect(r.compiled.provenance.map((p) => p.id)).toEqual(['stable-0'])
  })
})
