import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  persist: vi.fn(),
  record: vi.fn(),
  order: [] as string[],
  useEffectEngine: false,
  laneCurrent: vi.fn(),
  reserveAskCard: vi.fn(),
  bindAskCard: vi.fn(),
  supersedeAskCards: vi.fn(),
  ownerTurnCurrent: vi.fn(),
}))

vi.mock('@/agent/lib/live-browser/turn-owner-input', () => ({
  isTurnOwnerExecutionCurrent: mocks.ownerTurnCurrent,
}))

vi.mock('@/agent/lib/live-browser/turn-lane', () => ({
  DIRECT_YOUTUBE_LANE_UNAVAILABLE_TOOL_NAMES: new Set(['live_browser_status']),
  isDirectYouTubeTurnLaneTokenCurrent: mocks.laneCurrent,
  reserveDirectYouTubeAskCard: mocks.reserveAskCard,
  bindDirectYouTubeAskCard: mocks.bindAskCard,
  supersedeDirectYouTubeAskCards: mocks.supersedeAskCards,
}))

vi.mock('@/agent/lib/workflow-guards', () => ({
  WORKFLOW_GUARDED_TOOLS: new Set(['live_browser_look', 'live_browser_act']),
  WORKFLOW_HOOKED_TOOLS: new Set(['live_browser_look', 'live_browser_act']),
  checkWorkflowGuards: vi.fn(async () => null),
  consumeLiveBrowserObservationReceipt: mocks.consume,
  persistLiveBrowserActOutcome: mocks.persist,
  recordLiveBrowserLookReceipt: mocks.record,
  onWorkflowToolExecuted: vi.fn(),
}))

vi.mock('@/agent/lib/policy/tool-guard', () => ({
  guardToolCall: vi.fn(async () => ({
    action: 'proceed',
    envelope: {
      envelope: {
        idempotencyKey: 'browser-receipt-test', inputHash: 'hash', tool: 'live_browser_act',
        actor: 'owner', surface: 'owner', instructionOrigin: 'owner_direct', riskTier: 'R2', policyVersion: 'test',
      },
      signature: 'test-signature',
    },
    enforced: true,
    decision: { decision: 'allow', reasonClass: 'test', riskTier: 'R2' },
  })),
  releaseEffectClaim: vi.fn(),
}))

vi.mock('@/agent/lib/effects/action-run', () => ({
  effectEngineSelectionFromEnv: vi.fn(() => ({
    use: mocks.useEffectEngine,
    reason: mocks.useEffectEngine ? 'test_on' : 'test_off',
  })),
  executeEffect: vi.fn(async (req: { execute: () => Promise<{ success: boolean; data?: unknown; error?: string }> }) => {
    mocks.order.push('effect_engine')
    const result = await req.execute()
    return result.success
      ? { ok: true, state: 'succeeded', runId: 'run-1', replayed: false, result: result.data }
      : { ok: false, state: 'failed_final', runId: 'run-1', replayed: false, error: result.error, errorCode: 'effect_failed' }
  }),
}))

import { runRegisteredTool, type AgentTool } from '../registry'
import { strictenSchema } from '../tool-contract'

const ctx = {
  surface: 'owner' as const,
  conversationId: 'conv-browser',
  turnId: 'turn-browser',
  businessId: 'ALMA_LIFESTYLE',
  turnAuthorization: { allowMutations: true, reason: 'explicit_action' as const },
}

const actInput = {
  action: 'click',
  ref: 'e1',
  device: 'My Mac Chrome',
  observationReceipt: 'receipt-1234567890',
}

function browserTool(name: 'live_browser_look' | 'live_browser_act', handler: AgentTool['handler']): AgentTool {
  return {
    name,
    description: 'receipt registry test double',
    input_schema: strictenSchema(name === 'live_browser_act' ? {
      type: 'object',
      properties: {
        action: { type: 'string' },
        ref: { type: 'string' },
        device: { type: 'string' },
        observationReceipt: { type: 'string' },
      },
      required: ['action', 'device', 'observationReceipt'],
    } : {
      type: 'object', properties: {}, required: [],
    }) as AgentTool['input_schema'],
    handler,
  }
}

beforeEach(() => {
  mocks.consume.mockReset().mockImplementation(async () => {
    mocks.order.push('consume')
    return {
      blocked: false,
      claim: {
        commandId: '123e4567-e89b-42d3-a456-426614174000',
        observationReceipt: actInput.observationReceipt,
        device: actInput.device,
        deviceId: 'device-mac-1',
        currentUrl: 'https://example.com/current',
        documentId: 'document-identity',
        domObservationId: 'dom-generation-1',
        allowedRefs: ['e1'],
        refFingerprints: { e1: '["button","","button","","","Next",""]' },
      },
    }
  })
  mocks.persist.mockReset().mockImplementation(async () => {
    mocks.order.push('persist')
  })
  mocks.record.mockReset().mockResolvedValue({
    observationReceipt: 'look-receipt-1234567890',
    device: 'My Mac Chrome',
    deviceId: 'device-mac-1',
    currentUrl: 'https://example.com/current',
    documentId: 'document-identity',
    domObservationId: 'dom-generation-1',
    observationIssuedAt: new Date().toISOString(),
    observationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  mocks.order.length = 0
  mocks.useEffectEngine = false
  mocks.laneCurrent.mockReset().mockResolvedValue(true)
  mocks.reserveAskCard.mockReset().mockImplementation(async () => {
    mocks.order.push('reserve')
    return { askCardId: 'card-device' }
  })
  mocks.bindAskCard.mockReset().mockImplementation(async () => {
    mocks.order.push('bind')
    return true
  })
  mocks.supersedeAskCards.mockReset().mockResolvedValue(true)
  mocks.ownerTurnCurrent.mockReset().mockResolvedValue(true)
  delete process.env.AGENT_WORKFLOW_GUARDS
})

afterEach(() => {
  delete process.env.AGENT_WORKFLOW_GUARDS
})

describe('registry live-browser receipt lifecycle', () => {
  it('durably binds a direct ask card before returning it to the head', async () => {
    const tool: AgentTool = {
      name: 'ask_user',
      description: 'direct-lane ask card test double',
      input_schema: strictenSchema({ type: 'object', properties: {}, required: [] }) as AgentTool['input_schema'],
      handler: async () => {
        mocks.order.push('handler')
        return {
          success: true,
          data: { askCardId: 'card-device', options: ['Office Mac', 'Home Mac'] },
        }
      },
    }

    const result = await runRegisteredTool(tool, {}, {}, {
      ...ctx,
      directBrowserTask: true,
      directBrowserLaneToken: 'current-direct-token',
    })

    expect(result).toMatchObject({ success: true, data: { askCardId: 'card-device' } })
    expect(mocks.order).toEqual(['reserve', 'handler', 'bind'])
    expect(mocks.reserveAskCard).toHaveBeenCalledWith({
      conversationId: 'conv-browser',
      token: 'current-direct-token',
    })
    expect(mocks.bindAskCard).toHaveBeenCalledWith({
      conversationId: 'conv-browser',
      token: 'current-direct-token',
      askCardId: 'card-device',
      options: ['Office Mac', 'Home Mac'],
    })
  })

  it('never emits a direct ask card when durable binding fails', async () => {
    mocks.reserveAskCard.mockResolvedValueOnce({ askCardId: 'card-unbound' })
    mocks.bindAskCard.mockResolvedValueOnce(false)
    const tool: AgentTool = {
      name: 'ask_user',
      description: 'direct-lane ask card test double',
      input_schema: strictenSchema({ type: 'object', properties: {}, required: [] }) as AgentTool['input_schema'],
      handler: async () => ({
        success: true,
        data: { askCardId: 'card-unbound', options: ['Office Mac', 'Home Mac'] },
      }),
    }

    const result = await runRegisteredTool(tool, {}, {}, {
      ...ctx,
      directBrowserTask: true,
      directBrowserLaneToken: 'current-direct-token',
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('ASK_CARD_BINDING_FAILED')
  })

  it('never creates a direct card when its owner-turn identity cannot be reserved first', async () => {
    mocks.reserveAskCard.mockResolvedValueOnce(null)
    let handlerRan = false
    const tool: AgentTool = {
      name: 'ask_user',
      description: 'direct-lane ask card test double',
      input_schema: strictenSchema({ type: 'object', properties: {}, required: [] }) as AgentTool['input_schema'],
      handler: async () => {
        handlerRan = true
        return { success: true }
      },
    }

    const result = await runRegisteredTool(tool, {}, {}, {
      ...ctx,
      directBrowserTask: true,
      directBrowserLaneToken: 'current-direct-token',
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('ASK_CARD_RESERVATION_FAILED')
    expect(handlerRan).toBe(false)
    expect(mocks.bindAskCard).not.toHaveBeenCalled()
  })

  it('does not let an unavailable direct lane emit an unbound ask card', async () => {
    let handlerRan = false
    const tool: AgentTool = {
      name: 'ask_user',
      description: 'unavailable-lane ask card test double',
      input_schema: strictenSchema({
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      }) as AgentTool['input_schema'],
      handler: async () => {
        handlerRan = true
        return { success: true }
      },
    }

    const result = await runRegisteredTool(tool, { question: 'Continue?' }, {}, {
      ...ctx,
      directBrowserTask: true,
      directBrowserLaneUnavailable: true,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_FALLBACK_BLOCKED')
    expect(handlerRan).toBe(false)
    expect(mocks.laneCurrent).not.toHaveBeenCalled()
  })

  it('keeps personal-chat ask_user on the same stale-lane registry fence', async () => {
    mocks.laneCurrent.mockResolvedValueOnce(false)
    let handlerRan = false
    const tool: AgentTool = {
      name: 'ask_user',
      description: 'direct-lane ask card test double',
      input_schema: strictenSchema({
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      }) as AgentTool['input_schema'],
      handler: async () => {
        handlerRan = true
        return { success: true }
      },
    }

    const result = await runRegisteredTool(tool, { question: 'Which Mac?' }, {}, {
      ...ctx,
      directBrowserTask: true,
      directBrowserLaneToken: 'stale-personal-ask-token',
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('LANE_STALE')
    expect(handlerRan).toBe(false)
  })

  it('blocks a generic executor when YouTube computer-use wording misses the routing lane', async () => {
    let handlerRan = false
    const tool: AgentTool = {
      name: 'run_mac_command',
      description: 'generic Mac executor test double',
      input_schema: strictenSchema({ type: 'object', properties: {}, required: [] }) as AgentTool['input_schema'],
      handler: async () => {
        handlerRan = true
        return { success: true }
      },
    }
    const result = await runRegisteredTool(tool, {}, {}, {
      ...ctx,
      directBrowserTask: false,
      ownerRequestText: 'Make YouTube play Fix You',
    })
    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_LANE_REQUIRED')
    expect(handlerRan).toBe(false)
  })

  it('rejects an allowed browser tool when its durable lane token is stale', async () => {
    mocks.laneCurrent.mockResolvedValueOnce(false)
    let handlerRan = false
    const tool = browserTool('live_browser_act', async () => {
      handlerRan = true
      return { success: true }
    })
    const result = await runRegisteredTool(tool, actInput, {}, {
      ...ctx,
      directBrowserTask: true,
      directBrowserLaneToken: 'stale-turn-token',
    })
    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('LANE_STALE')
    expect(handlerRan).toBe(false)
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it('rechecks the immutable owner-turn fence immediately before dispatch', async () => {
    mocks.ownerTurnCurrent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    let handlerRan = false
    const tool = browserTool('live_browser_act', async () => {
      handlerRan = true
      return { success: true }
    })
    const result = await runRegisteredTool(tool, actInput, {}, {
      ...ctx,
      directBrowserTask: true,
      directBrowserLaneToken: 'current-direct-token',
    })
    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('OWNER_TURN_SUPERSEDED')
    expect(handlerRan).toBe(false)
    expect(mocks.consume).toHaveBeenCalledOnce()
    expect(mocks.ownerTurnCurrent).toHaveBeenCalledTimes(2)
  })

  it.each([
    { effectEngine: false, persistedPath: 'pre_dispatch' },
    { effectEngine: true, persistedPath: 'effect_engine' },
  ])(
    'rechecks the durable lane after receipt consumption before dispatch (effect engine: $effectEngine)',
    async ({ effectEngine, persistedPath }) => {
      mocks.useEffectEngine = effectEngine
      mocks.laneCurrent
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
      let handlerRan = false
      const tool = browserTool('live_browser_act', async () => {
        handlerRan = true
        return { success: true }
      })

      const result = await runRegisteredTool(tool, actInput, {}, {
        ...ctx,
        directBrowserTask: true,
        directBrowserLaneToken: 'current-then-superseded-token',
      })

      expect(result).toMatchObject({ success: false })
      expect(handlerRan).toBe(false)
      expect(mocks.consume).toHaveBeenCalledOnce()
      expect(mocks.laneCurrent).toHaveBeenCalledTimes(2)
      expect(mocks.persist).toHaveBeenCalledWith(
        actInput,
        undefined,
        expect.objectContaining({ conversationId: 'conv-browser', turnId: 'turn-browser' }),
        expect.objectContaining({ success: false, path: persistedPath }),
      )
    },
  )

  it('emits the exact stored receipt and document identity on every successful look', async () => {
    const tool = browserTool('live_browser_look', async () => ({
      success: true,
      data: { device: 'My Mac Chrome', currentUrl: 'https://example.com/current' },
    }))
    const result = await runRegisteredTool(tool, {}, {}, ctx)
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      observationReceipt: 'look-receipt-1234567890',
      device: 'My Mac Chrome',
      deviceId: 'device-mac-1',
      currentUrl: 'https://example.com/current',
      documentId: 'document-identity',
      domObservationId: 'dom-generation-1',
      observationIssuedAt: expect.any(String),
    })
    expect(mocks.record).toHaveBeenCalledOnce()
  })

  it('fails closed before the handler with missing turn/context even when advisory guards are disabled', async () => {
    process.env.AGENT_WORKFLOW_GUARDS = 'false'
    let handlerRan = false
    mocks.consume.mockResolvedValueOnce({
      blocked: true,
      guard: 'browser_observation_context_required',
      error: 'fresh look context required',
    })
    const tool = browserTool('live_browser_act', async () => {
      handlerRan = true
      return { success: true }
    })
    const result = await runRegisteredTool(tool, actInput, {}, {
      surface: 'owner',
      turnAuthorization: { allowMutations: true, reason: 'explicit_action' },
    })
    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(handlerRan).toBe(false)
    expect(mocks.consume).toHaveBeenCalledOnce()
  })

  it('consumes before direct dispatch and centrally persists success', async () => {
    const tool = browserTool('live_browser_act', async (handlerInput) => {
      mocks.order.push('handler')
      expect(handlerInput.browserObservationClaim).toMatchObject({
        commandId: '123e4567-e89b-42d3-a456-426614174000',
        currentUrl: 'https://example.com/current',
        documentId: 'document-identity',
        deviceId: 'device-mac-1',
        domObservationId: 'dom-generation-1',
        allowedRefs: ['e1'],
        refFingerprints: { e1: expect.any(String) },
      })
      return { success: true, data: { ok: true } }
    })
    const result = await runRegisteredTool(tool, actInput, {}, ctx)
    expect(result.success).toBe(true)
    expect(mocks.order).toEqual(['consume', 'handler', 'persist'])
    expect(mocks.persist).toHaveBeenCalledWith(
      actInput,
      { ok: true },
      expect.objectContaining({ conversationId: 'conv-browser', turnId: 'turn-browser' }),
      { success: true, path: 'handler' },
    )
  })

  it('centrally persists returned failure and thrown outcome paths', async () => {
    const failed = browserTool('live_browser_act', async () => ({ success: false, error: 'element not found' }))
    const failedResult = await runRegisteredTool(failed, actInput, {}, { ...ctx, turnId: 'turn-failure' })
    expect(failedResult.success).toBe(false)
    expect(mocks.persist).toHaveBeenLastCalledWith(
      actInput,
      undefined,
      expect.objectContaining({ turnId: 'turn-failure' }),
      expect.objectContaining({ success: false, path: 'handler', errorCode: 'not_found' }),
    )

    mocks.order.length = 0
    mocks.consume.mockClear()
    mocks.persist.mockClear()
    const throwing = browserTool('live_browser_act', async () => {
      throw new Error('socket hang up')
    })
    const thrownResult = await runRegisteredTool(throwing, actInput, {}, { ...ctx, turnId: 'turn-throw' })
    expect(thrownResult.success).toBe(false)
    expect(mocks.persist).toHaveBeenCalledWith(
      actInput,
      undefined,
      expect.objectContaining({ turnId: 'turn-throw' }),
      expect.objectContaining({ success: false, path: 'throw' }),
    )
  })

  it('consumes before effect-engine dispatch and persists its outcome', async () => {
    mocks.useEffectEngine = true
    const tool = browserTool('live_browser_act', async () => {
      mocks.order.push('handler')
      return { success: true, data: { clicked: true } }
    })
    const result = await runRegisteredTool(tool, actInput, {}, { ...ctx, turnId: 'turn-effect' })
    expect(result.success).toBe(true)
    expect(mocks.order).toEqual(['consume', 'effect_engine', 'handler', 'persist'])
    expect(mocks.persist).toHaveBeenCalledWith(
      actInput,
      { clicked: true },
      expect.objectContaining({ turnId: 'turn-effect' }),
      { success: true, path: 'effect_engine' },
    )
  })

  it('does not reopen a consumed receipt when outcome persistence fails', async () => {
    mocks.persist.mockRejectedValueOnce(new Error('database unavailable'))
    const tool = browserTool('live_browser_act', async () => ({ success: true, data: { clicked: true } }))
    const result = await runRegisteredTool(tool, actInput, {}, { ...ctx, turnId: 'turn-persist-fail' })
    expect(result.success).toBe(true)
    expect(mocks.consume).toHaveBeenCalledOnce()
    expect(mocks.persist).toHaveBeenCalledOnce()
  })
})
