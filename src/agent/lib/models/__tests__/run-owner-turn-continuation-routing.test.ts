import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTINUATION_BINDING_BLOCKER,
  directBrowserOwnerInputForTurn,
  turnScopedOwnerInput,
} from '@/agent/lib/live-browser/turn-owner-input'

const prismaMock = vi.hoisted(() => ({
  agentMessage: {
    create: vi.fn(async () => ({ id: 'guard-message-1' })),
  },
  agentConversation: {
    update: vi.fn(async () => ({})),
  },
  agentKvSetting: {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import {
  runOwnerTurn,
  sourceBoundContinuationCapabilities,
  supplySourceBoundWorkflowTools,
} from '@/agent/lib/models/run-owner-turn'
import { DEFAULT_AGENT_CONTROLS } from '@/agent/lib/agent-controls'
import { filterTurnToolDefinitions } from '@/agent/tools/selection/turn-capability-context'

describe('runOwnerTurn source-bound continuation routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('settles an unbound internal continuation server-side with zero lane/tool events', async () => {
    const events = []
    for await (const event of runOwnerTurn('conv-1', {
      continuation: true,
      turnId: 'turn-unbound',
      turnOwnerInput: {
        state: 'bound',
        messageId: 'historical-continue',
        createdAt: new Date('2026-08-23T00:00:00.000Z'),
        text: 'Continue',
        askCardId: null,
      },
      continuationBinding: { state: 'absent' },
    })) events.push(event)

    expect(events).toEqual([
      { type: 'text_delta', delta: CONTINUATION_BINDING_BLOCKER },
      {
        type: 'done',
        messageId: 'guard-message-1',
        tokensIn: 0,
        tokensOut: 0,
        cacheCreation: 0,
        cacheRead: 0,
        costUsd: 0,
        // The guard terminal states the reference contract like every other
        // terminal (stream-contract guard); hidden rollout here → inactive.
        references: undefined,
        referencesActive: false,
      },
    ])
    expect(events.some((event) => event.type === 'tool_start' || event.type === 'tool_end')).toBe(false)
    expect(prismaMock.agentMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        usage: expect.objectContaining({ model: 'server-continuation-binding-guard' }),
      }),
    }))
    // HOP BRAKE (runaway 2026-08-24): the guard-blocked hop durably HALTS the
    // self-continue chain, so no successor hop can ever be scheduled off it.
    expect(prismaMock.agentKvSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'self_continue_stop:conv-1' },
    }))
  })

  it('source-bound SEO plus historical Continue produces no direct-browser route', () => {
    const scoped = turnScopedOwnerInput({
      state: 'bound',
      messageId: 'historical-continue',
      createdAt: new Date('2026-08-23T00:00:00.000Z'),
      text: 'Continue',
      askCardId: null,
    }, 'Continue')

    expect(directBrowserOwnerInputForTurn(scoped, {
      state: 'bound',
      binding: { domain: 'seo' },
    })).toEqual({ state: 'none' })
  })

  it('keeps exact current owner Continue eligible for the durable YouTube lane', () => {
    const scoped = turnScopedOwnerInput({
      state: 'bound',
      messageId: 'current-owner-continue',
      createdAt: new Date('2026-08-23T00:00:01.000Z'),
      text: 'Continue',
      askCardId: null,
    }, 'Continue')

    expect(directBrowserOwnerInputForTurn(scoped, { state: 'absent' })).toEqual({
      state: 'resolve',
      ownerRequest: 'Continue',
      askCardId: null,
    })
  })

  it('wires the owner-input authority helper and removes unavailable-history lane fabrication', () => {
    const source = readFileSync(new URL('../run-owner-turn.ts', import.meta.url), 'utf8')
    expect(source).toContain('directBrowserOwnerInputForTurn(')
    expect(source).not.toMatch(
      /scopedOwnerInput\.state === 'unavailable'[\s\S]{0,100}\{ state: 'unavailable', ownerRequest:/,
    )
  })

  it('authorizes, supplies, and drives only the exact bound SEO workflow without transcript text', async () => {
    const capabilities = sourceBoundContinuationCapabilities({
      v: 1,
      origin: 'open_task',
      source: { kind: 'open_task', id: 'open-task-seo-1' },
      conversationId: 'conv-1',
      domain: 'seo',
      event: 'resume_requested',
      workflowRunId: 'workflow-seo-1',
      directive: { kind: 'open_task_resume', version: 1 },
      expected: {
        sourceStatus: ['open'], sourceType: 'chat_followup',
        workflowKind: 'client_seo_batch', workflowStateVersion: 7,
      },
    }, [
      {
        id: 'workflow-unrelated', kind: 'client_seo_batch',
        nextAllowedTools: ['live_browser_act'],
      },
      {
        id: 'workflow-seo-1', kind: 'client_seo_batch',
        nextAllowedTools: ['draft_seo_fixes', 'run_website_seo_audit'],
      },
    ])

    expect(capabilities.authorization).toEqual({
      allowMutations: true, reason: 'workflow_continuation',
    })
    expect(capabilities.driveClientSeoBatch).toBe(true)
    expect(capabilities.requiredToolNames).toEqual([
      'draft_seo_fixes', 'run_website_seo_audit',
    ])
    expect(capabilities.chromeModality).toBe(false)
    expect(capabilities.ownerIntentGateEnabled).toBe(false)

    const supplied = await supplySourceBoundWorkflowTools(
      [{ name: 'find_tool', description: 'find', input_schema: { type: 'object' as const } }],
      capabilities.requiredToolNames,
      async (names) => names.map((name) => ({
        name, description: name, input_schema: { type: 'object' as const },
      })),
    )
    const selected = filterTurnToolDefinitions(supplied, {
      ownerText: '',
      turnAllowlist: null,
      turnDenylist: new Set(),
      turnAuthorization: capabilities.authorization!,
      agentControls: DEFAULT_AGENT_CONTROLS,
      chatMode: 'auto',
      permissionMode: 'elevated',
      actorRoles: ['owner'],
      ownerIntentGateEnabled: capabilities.ownerIntentGateEnabled,
      isCatalogAvailable: () => true,
    }).tools.map((tool) => tool.name)
    expect(selected).toEqual(expect.arrayContaining([
      'draft_seo_fixes', 'run_website_seo_audit',
    ]))
  })

  it('fails closed when the named workflow is missing or its kind mismatches', () => {
    const binding = {
      v: 1 as const,
      origin: 'open_task' as const,
      source: { kind: 'open_task' as const, id: 'open-task-seo-1' },
      conversationId: 'conv-1', domain: 'seo' as const,
      event: 'resume_requested' as const,
      workflowRunId: 'workflow-seo-1',
      directive: { kind: 'open_task_resume' as const, version: 1 as const },
      expected: {
        sourceStatus: ['open'], sourceType: 'chat_followup',
        workflowKind: 'client_seo_batch', workflowStateVersion: 7,
      },
    }

    const missing = sourceBoundContinuationCapabilities(binding, [{
      id: 'workflow-unrelated', kind: 'client_seo_batch',
      nextAllowedTools: ['run_website_seo_audit'],
    }])
    const mismatch = sourceBoundContinuationCapabilities(binding, [{
      id: 'workflow-seo-1', kind: 'creative_campaign',
      nextAllowedTools: ['run_website_seo_audit'],
    }])

    for (const capabilities of [missing, mismatch]) {
      expect(capabilities.authorization).toBeNull()
      expect(capabilities.driveClientSeoBatch).toBe(false)
      expect(capabilities.requiredToolNames).toEqual([])
      expect(capabilities.chromeModality).toBe(false)
      expect(capabilities.ownerIntentGateEnabled).toBe(true)
    }
  })

  it('never infers Chrome from browser domain/history; only the immutable modality widens it', () => {
    const browserBinding = {
      v: 1 as const,
      origin: 'self_continue' as const,
      source: { kind: 'turn' as const, id: 'turn-browser-1' },
      conversationId: 'conv-1',
      domain: 'browser' as const,
      event: 'deadline_resume' as const,
      directive: { kind: 'deadline_resume' as const, version: 1 as const },
      expected: { sourceStatus: ['done'] },
    }

    expect(sourceBoundContinuationCapabilities(browserBinding, []).chromeModality).toBe(false)
    expect(sourceBoundContinuationCapabilities({
      ...browserBinding,
      modalities: ['chrome'] as Array<'chrome'>,
    }, []).chromeModality).toBe(true)
  })
})
