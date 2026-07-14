import { describe, it, expect } from 'vitest'
import { buildOpenAiRequestShaping, wantsAnthropicCacheControl } from '../openai'
import { buildGeminiToolConfig } from '../google'
import type { NeutralTool } from '@/agent/lib/models/types'

const TOOLS: NeutralTool[] = [
  { name: 'get_product', description: 'x', schema: { type: 'object', properties: {} } },
]

describe('OpenAI-dialect request shaping (Phase 3)', () => {
  it('omits everything when no controls are passed (pre-Phase-3 request unchanged)', () => {
    expect(buildOpenAiRequestShaping({ tools: TOOLS })).toEqual({})
  })

  it('omits everything when the request carries no tools (tool_choice without tools 400s)', () => {
    expect(buildOpenAiRequestShaping({ tools: [], toolChoice: 'none', parallelToolCalls: false })).toEqual({})
  })

  it("'auto' is the provider default — not emitted", () => {
    expect(buildOpenAiRequestShaping({ tools: TOOLS, toolChoice: 'auto' })).toEqual({})
  })

  it("maps 'none' / 'required' / named tool", () => {
    expect(buildOpenAiRequestShaping({ tools: TOOLS, toolChoice: 'none' })).toEqual({ tool_choice: 'none' })
    expect(buildOpenAiRequestShaping({ tools: TOOLS, toolChoice: 'required' })).toEqual({ tool_choice: 'required' })
    expect(buildOpenAiRequestShaping({ tools: TOOLS, toolChoice: { name: 'get_product' } })).toEqual({
      tool_choice: { type: 'function', function: { name: 'get_product' } },
    })
  })

  it('maps parallel_tool_calls both ways', () => {
    expect(buildOpenAiRequestShaping({ tools: TOOLS, parallelToolCalls: false })).toEqual({ parallel_tool_calls: false })
    expect(buildOpenAiRequestShaping({ tools: TOOLS, parallelToolCalls: true })).toEqual({ parallel_tool_calls: true })
  })
})

describe('Grok cache_control cleanup (audit correction #4)', () => {
  it('x-ai/* models skip the Anthropic-style cache_control (Grok auto-caches)', () => {
    expect(wantsAnthropicCacheControl('x-ai/grok-4.20')).toBe(false)
  })
  it('other OpenRouter models keep it', () => {
    expect(wantsAnthropicCacheControl('deepseek/deepseek-chat-v4')).toBe(true)
    expect(wantsAnthropicCacheControl('qwen/qwen3-max')).toBe(true)
    expect(wantsAnthropicCacheControl('anthropic/claude-sonnet-4.5')).toBe(true)
  })
})

describe('Gemini functionCallingConfig mapping (Phase 3)', () => {
  it('absent/auto/no-tools → undefined (request unchanged)', () => {
    expect(buildGeminiToolConfig(undefined, true)).toBeUndefined()
    expect(buildGeminiToolConfig('auto', true)).toBeUndefined()
    expect(buildGeminiToolConfig('required', false)).toBeUndefined()
  })

  it("maps 'none' / 'required' / named tool", () => {
    expect(buildGeminiToolConfig('none', true)).toEqual({ functionCallingConfig: { mode: 'NONE' } })
    expect(buildGeminiToolConfig('required', true)).toEqual({ functionCallingConfig: { mode: 'ANY' } })
    expect(buildGeminiToolConfig({ name: 'get_product' }, true)).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_product'] },
    })
  })
})
