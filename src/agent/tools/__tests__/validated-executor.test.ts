import { describe, it, expect } from 'vitest'
import { runRegisteredTool, executeTool, type AgentTool } from '../registry'
import { validateToolInput, strictenSchema, isRetryableErrorCode, clearValidatorCache } from '../tool-contract'

function fakeTool(overrides: Partial<AgentTool> & { handler: AgentTool['handler'] }): AgentTool {
  return {
    name: overrides.name ?? 'fake_tool',
    description: 'test tool',
    input_schema: strictenSchema(
      overrides.input_schema ?? {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'a number' },
          mode: { type: 'string', enum: ['a', 'b'], description: 'a mode' },
        },
        required: ['count'],
      },
    ) as AgentTool['input_schema'],
    handler: overrides.handler,
  }
}

describe('validated executor (Phase 2)', () => {
  it('server rejects a write even if a model somehow calls it on a read-only turn', async () => {
    let handlerRan = false
    const tool = fakeTool({
      name: 'fake_unclassified_write',
      handler: async () => {
        handlerRan = true
        return { success: true }
      },
    })
    const res = await runRegisteredTool(tool, { count: 1 }, {}, {
      turnAuthorization: { allowMutations: false, reason: 'information_only' },
    })
    expect(handlerRan).toBe(false)
    expect(res).toMatchObject({ success: false, errorCode: 'turn_read_only', retryable: false })
  })

  it('invalid args NEVER reach the handler — unknown field', async () => {
    let handlerRan = false
    clearValidatorCache()
    const tool = fakeTool({
      name: 'fake_unknown_field',
      handler: async () => {
        handlerRan = true
        return { success: true }
      },
    })
    const res = await runRegisteredTool(tool, { count: 1, bogus: 'x' }, {}, {})
    expect(handlerRan).toBe(false)
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('invalid_args')
    expect(res.retryable).toBe(false)
    expect(res.error).toContain('bogus')
    expect(res.error).toContain('count') // allowed-fields hint for the model
  })

  it('invalid args NEVER reach the handler — missing required field', async () => {
    let handlerRan = false
    clearValidatorCache()
    const tool = fakeTool({
      name: 'fake_missing_required',
      handler: async () => {
        handlerRan = true
        return { success: true }
      },
    })
    const res = await runRegisteredTool(tool, { mode: 'a' }, {}, {})
    expect(handlerRan).toBe(false)
    expect(res.errorCode).toBe('invalid_args')
  })

  it('coerces Gemini string round-trips ("5" → 5) instead of rejecting', async () => {
    let seen: unknown
    clearValidatorCache()
    const tool = fakeTool({
      name: 'fake_coerce',
      handler: async (input) => {
        seen = input.count
        return { success: true }
      },
    })
    const res = await runRegisteredTool(tool, { count: '5' as unknown as number, mode: 'a' }, {}, {})
    expect(res.success).toBe(true)
    expect(seen).toBe(5)
  })

  it('server context is merged AFTER validation and wins on collisions', async () => {
    let seen: Record<string, unknown> = {}
    clearValidatorCache()
    const tool = fakeTool({
      name: 'fake_ctx',
      handler: async (input) => {
        seen = input
        return { success: true }
      },
    })
    const res = await runRegisteredTool(tool, { count: 2 }, { businessId: 'ALMA_TRADING', conversationId: 'c1' }, {})
    expect(res.success).toBe(true)
    expect(seen.businessId).toBe('ALMA_TRADING') // not part of the schema, still delivered
    expect(seen.count).toBe(2)
  })

  it('envelope: handler failure gets a stable errorCode + retryable', async () => {
    clearValidatorCache()
    const tool = fakeTool({
      name: 'fake_timeout',
      handler: async () => ({ success: false, error: 'fetch failed: ETIMEDOUT after 30s' }),
    })
    const res = await runRegisteredTool(tool, { count: 1 }, {}, {})
    expect(res.errorCode).toBe('timeout')
    expect(res.retryable).toBe(true)
  })

  it('envelope: handler-declared errorCode/retryable are preserved', async () => {
    clearValidatorCache()
    const tool = fakeTool({
      name: 'fake_declared',
      handler: async () => ({ success: false, error: 'special case', errorCode: 'not_found', retryable: true }),
    })
    const res = await runRegisteredTool(tool, { count: 1 }, {}, {})
    expect(res.errorCode).toBe('not_found')
    expect(res.retryable).toBe(true)
  })

  it('envelope: thrown exceptions are classified and marked', async () => {
    clearValidatorCache()
    const tool = fakeTool({
      name: 'fake_throw',
      handler: async () => {
        throw new Error('socket hang up — network reset')
      },
    })
    const res = await runRegisteredTool(tool, { count: 1 }, {}, {})
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('network')
    expect(res.retryable).toBe(true)
  })

  it('executeTool: unknown tool returns unknown_tool envelope', async () => {
    const res = await executeTool('definitely_not_a_tool', {})
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('unknown_tool')
    expect(res.retryable).toBe(false)
  })

  it('executeTool: real registered tool rejects unknown fields end-to-end', async () => {
    // get_current_datetime takes NO params — an unknown field must be rejected
    // by central validation before the handler runs.
    const res = await executeTool('get_current_datetime', { timezone: 'UTC' })
    expect(res.success).toBe(false)
    expect(res.errorCode).toBe('invalid_args')
  })

  it('executeTool: real registered tool works with valid args', async () => {
    const res = await executeTool('get_current_datetime', {})
    expect(res.success).toBe(true)
    expect((res.data as { timezone: string }).timezone).toContain('Asia/Dhaka')
  })
})

describe('validateToolInput details', () => {
  it('reports every problem at once (allErrors)', () => {
    clearValidatorCache()
    const schema = strictenSchema({
      type: 'object',
      properties: {
        a: { type: 'number', description: 'x' },
        b: { type: 'string', description: 'y' },
      },
      required: ['a', 'b'],
    })
    const v = validateToolInput('multi_error_case', schema, { c: 1 } as Record<string, unknown>)
    expect(v.ok).toBe(false)
    expect(v.error).toContain('a')
    expect(v.error).toContain('b')
    expect(v.error).toContain('c')
  })

  it('retryable code set is exactly the transient class', () => {
    expect(isRetryableErrorCode('timeout')).toBe(true)
    expect(isRetryableErrorCode('rate_limited')).toBe(true)
    expect(isRetryableErrorCode('network')).toBe(true)
    expect(isRetryableErrorCode('provider_5xx')).toBe(true)
    expect(isRetryableErrorCode('invalid_args')).toBe(false)
    expect(isRetryableErrorCode('not_found')).toBe(false)
    expect(isRetryableErrorCode('unknown_tool')).toBe(false)
    expect(isRetryableErrorCode(undefined)).toBe(false)
  })
})
