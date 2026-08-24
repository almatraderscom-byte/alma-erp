import { beforeEach, describe, expect, it, vi } from 'vitest'

type TurnRow = {
  id: string
  conversationId: string
  requestId: string | null
  continuationBinding: unknown
  continuationExecutionClaimedAt: Date | null
  status: string
  executionMode: string | null
}

const state = vi.hoisted(() => ({
  turns: [] as TurnRow[],
  actions: new Map<string, Record<string, unknown>>(),
  workflows: new Map<string, Record<string, unknown>>(),
  workflowEvents: [] as Array<Record<string, unknown>>,
  outboxes: [] as Array<Record<string, unknown>>,
  openTasks: new Map<string, Record<string, unknown>>(),
  focuses: new Map<string, Record<string, unknown>>(),
  messages: new Map<string, Record<string, unknown>>(),
  plans: new Map<string, Record<string, unknown>>(),
  planSteps: new Map<string, Record<string, unknown>>(),
  kv: new Map<string, string>(),
  findingSets: new Map<string, Record<string, unknown>>(),
  sequence: 0,
}))

vi.mock('@/lib/prisma', () => {
  const matches = (row: TurnRow, where: Record<string, unknown>) => {
    if (typeof where.id === 'string' && row.id !== where.id) return false
    if (typeof where.conversationId === 'string' && row.conversationId !== where.conversationId) return false
    if ('requestId' in where) {
      if (where.requestId === null && row.requestId !== null) return false
      if (typeof where.requestId === 'string' && row.requestId !== where.requestId) return false
    }
    if ('continuationExecutionClaimedAt' in where) {
      const expected = where.continuationExecutionClaimedAt
      if (expected === null && row.continuationExecutionClaimedAt !== null) return false
      // CAS reclaim (Codex P1): the lease is retaken against the exact stale
      // timestamp, so the fake must compare Date VALUES like Prisma does.
      if (expected instanceof Date && (
        row.continuationExecutionClaimedAt == null
        || row.continuationExecutionClaimedAt.getTime() !== expected.getTime()
      )) return false
    }
    if (typeof where.status === 'string' && row.status !== where.status) return false
    return true
  }

  const tx = {
    agentTurn: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; requestId?: string } }) => {
        if (where.id) return state.turns.find((row) => row.id === where.id) ?? null
        if (where.requestId) return state.turns.find((row) => row.requestId === where.requestId) ?? null
        return null
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
        state.turns.find((row) => matches(row, where)) ?? null
      )),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: TurnRow = {
          id: `turn-${++state.sequence}`,
          conversationId: String(data.conversationId),
          requestId: typeof data.requestId === 'string' ? data.requestId : null,
          continuationBinding: data.continuationBinding ?? null,
          continuationExecutionClaimedAt: null,
          status: String(data.status ?? 'running'),
          executionMode: typeof data.executionMode === 'string' ? data.executionMode : null,
        }
        if (row.requestId && state.turns.some((candidate) => candidate.requestId === row.requestId)) {
          throw Object.assign(new Error('unique request id'), { code: 'P2002' })
        }
        state.turns.push(row)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = state.turns.find((candidate) => matches(candidate, where))
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      }),
    },
    agentPendingAction: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.actions.get(where.id) ?? null),
    },
    workflowRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.workflows.get(where.id) ?? null),
    },
    workflowRunEvent: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
        state.workflowEvents.find((row) => row.id === where.id) ?? null
      )),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const detail = where.detail as { equals?: string } | undefined
        return state.workflowEvents.filter((row) => (
          (row.detail as Record<string, unknown> | undefined)?.turnId === detail?.equals
        ))
      }),
    },
    agentArtifactDeliveryOutbox: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.outboxes.find((row) => (
        row.sourceKind === where.sourceKind
        && row.sourceId === where.sourceId
        && (!where.status || row.status === where.status)
      )) ?? null),
    },
    agentOpenTask: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.openTasks.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
        [...state.openTasks.values()].filter((row) => (
          row.conversationId === where.conversationId
          && ((where.status as { in?: string[] } | undefined)?.in ?? []).includes(String(row.status))
          && ((where.kind as { in?: string[] } | undefined)?.in ?? []).includes(String(row.kind))
        ))
      )),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = state.openTasks.get(String(where.id))
        if (!row || (where.status && row.status !== where.status)) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      }),
    },
    agentMessage: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
        [...state.messages.values()].find((row) => (
          (where.id && row.id === where.id)
          || (where.clientRequestId && row.clientRequestId === where.clientRequestId)
        )) ?? null
      )),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const ids = ((where.id as { in?: string[] } | undefined)?.in ?? [])
        return ids
          .map((id) => state.messages.get(id))
          .filter((row): row is Record<string, unknown> => Boolean(
            row
            && row.conversationId === where.conversationId
            && row.role === where.role,
          ))
      }),
    },
    agentConversationFocus: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.focuses.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
        [...state.focuses.values()].filter((row) => (
          row.conversationId === where.conversationId
          && ((where.status as { in?: string[] } | undefined)?.in ?? []).includes(String(row.status))
        ))
      )),
    },
    agentPlanStep: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const step = state.planSteps.get(where.id)
        if (!step) return null
        return { ...step, plan: state.plans.get(String(step.planId)) ?? null }
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const step = state.planSteps.get(String(where.id))
        if (!step || (where.planId && step.planId !== where.planId)) return { count: 0 }
        const statuses = (where.status as { in?: string[] } | undefined)?.in
        if (statuses && !statuses.includes(String(step.status))) return { count: 0 }
        const allowedTurns = Array.isArray(where.OR)
          ? (where.OR as Array<Record<string, unknown>>).some((item) => item.turnId === step.turnId)
          : true
        if (!allowedTurns) return { count: 0 }
        Object.assign(step, data)
        return { count: 1 }
      }),
    },
    agentPlan: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.plans.get(where.id) ?? null),
    },
    agentKvSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const value = state.kv.get(where.key)
        return value === undefined ? null : { key: where.key, value }
      }),
    },
    agentFindingSet: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.findingSets.get(where.id) ?? null),
    },
  }

  return {
    prisma: {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  }
})

import {
  ContinuationBindingError,
  bindContinuationTurn,
  buildPlanStepContinuationBinding,
  buildSelfContinueBinding,
  CONTINUATION_EXECUTION_LEASE_MS,
  claimContinuationExecution,
  continuationDomainForWorkflowKind,
  continuationRequestId,
  createOrReuseSpecialistBriefContinuation,
  findExistingBoundContinuationTurn,
  loadContinuationBindingForTurn,
  renderContinuationDirective,
  settleUnclaimedOpenTaskContinuation,
  sourceBoundContinuationsEnabled,
  type ContinuationBindingV1,
} from '@/agent/lib/continuation-binding'

const SEO_BINDING: ContinuationBindingV1 = {
  v: 1,
  origin: 'job_result',
  source: { kind: 'pending_action', id: 'action-1' },
  conversationId: 'conv-1',
  domain: 'seo',
  event: 'artifact_delivered',
  workflowRunId: 'workflow-1',
  directive: { kind: 'seo_artifact_delivered', version: 1 },
  expected: {
    sourceStatus: ['executed'],
    sourceType: 'seo_audit',
    workflowKind: 'client_seo_batch',
    workflowStateVersion: 4,
    deliveryState: 'delivered',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  state.turns.length = 0
  state.actions.clear()
  state.workflows.clear()
  state.workflowEvents.length = 0
  state.outboxes.length = 0
  state.openTasks.clear()
  state.focuses.clear()
  state.messages.clear()
  state.plans.clear()
  state.planSteps.clear()
  state.kv.clear()
  state.findingSets.clear()
  state.sequence = 0
  state.actions.set('action-1', {
    id: 'action-1',
    conversationId: 'conv-1',
    type: 'seo_audit',
    status: 'executed',
    workflowRunId: 'workflow-1',
    result: { ok: true },
  })
  state.workflows.set('workflow-1', {
    id: 'workflow-1',
    conversationId: 'conv-1',
    kind: 'client_seo_batch',
    status: 'active',
    state: 'audit_finished',
    stateVersion: 4,
    pendingActionId: 'action-1',
  })
  state.outboxes.push({
    id: 'outbox-1',
    sourceKind: 'pending_action',
    sourceId: 'action-1',
    status: 'delivered',
  })
})

describe('source-bound continuation identity', () => {
  it('defaults on and uses an explicit off value only as an automation kill switch', () => {
    const previous = process.env.AGENT_SOURCE_BOUND_CONTINUATIONS
    try {
      delete process.env.AGENT_SOURCE_BOUND_CONTINUATIONS
      expect(sourceBoundContinuationsEnabled()).toBe(true)
      process.env.AGENT_SOURCE_BOUND_CONTINUATIONS = 'false'
      expect(sourceBoundContinuationsEnabled()).toBe(false)
      process.env.AGENT_SOURCE_BOUND_CONTINUATIONS = 'on'
      expect(sourceBoundContinuationsEnabled()).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.AGENT_SOURCE_BOUND_CONTINUATIONS
      else process.env.AGENT_SOURCE_BOUND_CONTINUATIONS = previous
    }
  })

  it('derives one stable namespaced request id and maps workflow domains', () => {
    expect(continuationRequestId(SEO_BINDING)).toBe(
      'continuation:v1:job_result:pending_action:action-1:artifact_delivered',
    )
    expect(continuationDomainForWorkflowKind('client_seo_batch')).toBe('seo')
    expect(continuationDomainForWorkflowKind('browser_setup')).toBe('browser')
    expect(continuationDomainForWorkflowKind('untemplated')).toBe('generic')
  })

  it.each([
    ['SEO', 'client_seo_batch', 'seo'],
    ['browser', 'browser_setup', 'browser'],
  ] as const)('binds a %s deadline wake to the exact persisted workflow event', async (_label, kind, domain) => {
    state.turns.push({
      id: 'deadline-source', conversationId: 'conv-1', requestId: null,
      continuationBinding: null, continuationExecutionClaimedAt: null,
      status: 'done', executionMode: null,
    })
    state.workflows.set('deadline-workflow', {
      id: 'deadline-workflow', conversationId: 'conv-1', kind,
      status: 'active', state: 'deadline_paused', stateVersion: 7,
      pendingActionId: null,
    })
    state.workflowEvents.push({
      id: `event-${domain}`, workflowRunId: 'deadline-workflow',
      detail: { turnId: 'deadline-source' }, ts: new Date(),
    })

    const binding = await buildSelfContinueBinding({
      conversationId: 'conv-1', sourceTurnId: 'deadline-source',
    })
    expect(binding).toMatchObject({
      origin: 'self_continue',
      source: { kind: 'turn', id: 'deadline-source' },
      domain,
      workflowRunId: 'deadline-workflow',
      authorityRef: { kind: 'workflow_event', id: `event-${domain}` },
      expected: { workflowKind: kind, workflowStateVersion: 7 },
    })
    const bound = await bindContinuationTurn({ binding })
    await expect(claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })).resolves.toMatchObject({ outcome: 'claimed', binding })
  })

  it('inherits domain/workflow only from the predecessor immutable binding', async () => {
    state.turns.push({
      id: 'bound-deadline-source', conversationId: 'conv-1',
      requestId: continuationRequestId(SEO_BINDING),
      continuationBinding: SEO_BINDING, continuationExecutionClaimedAt: new Date(),
      status: 'done', executionMode: 'worker',
    })
    const binding = await buildSelfContinueBinding({
      conversationId: 'conv-1', sourceTurnId: 'bound-deadline-source',
    })
    expect(binding).toMatchObject({
      source: { kind: 'turn', id: 'bound-deadline-source' },
      domain: 'seo', workflowRunId: 'workflow-1',
      authorityRef: {
        kind: 'source_binding', id: continuationRequestId(SEO_BINDING),
      },
    })
  })

  it('fails closed when persisted context is absent or ambiguous', async () => {
    state.turns.push({
      id: 'unbound-source', conversationId: 'conv-1', requestId: null,
      continuationBinding: null, continuationExecutionClaimedAt: null,
      status: 'running', executionMode: null,
    })
    await expect(buildSelfContinueBinding({
      conversationId: 'conv-1', sourceTurnId: 'unbound-source',
    })).rejects.toMatchObject({ code: 'continuation_self_authority_missing' })

    state.workflowEvents.push(
      { id: 'event-a', workflowRunId: 'workflow-1', detail: { turnId: 'unbound-source' } },
      { id: 'event-b', workflowRunId: 'workflow-2', detail: { turnId: 'unbound-source' } },
    )
    await expect(buildSelfContinueBinding({
      conversationId: 'conv-1', sourceTurnId: 'unbound-source',
    })).rejects.toMatchObject({ code: 'continuation_self_source_ambiguous' })
  })

  it('uses an exact no-workflow deadline checkpoint and never its prose as authority', async () => {
    state.turns.push({
      id: 'checkpoint-source', conversationId: 'conv-1', requestId: null,
      continuationBinding: null, continuationExecutionClaimedAt: null,
      status: 'done', executionMode: null,
    })
    state.openTasks.set('checkpoint-1', {
      id: 'checkpoint-1', conversationId: 'conv-1', kind: 'checkpoint_waiting',
      status: 'open', workflowRunId: null,
      resumeNote: 'untrusted prose is never copied into the binding',
      checkpoint: { taskRef: 'checkpoint-source', taskType: 'browser' },
    })
    const binding = await buildSelfContinueBinding({
      conversationId: 'conv-1', sourceTurnId: 'checkpoint-source',
    })
    expect(binding).toMatchObject({
      source: { kind: 'turn', id: 'checkpoint-source' },
      domain: 'browser',
      authorityRef: { kind: 'checkpoint', id: 'checkpoint-1' },
    })
    expect(JSON.stringify(binding)).not.toContain('untrusted prose')
    const bound = await bindContinuationTurn({ binding })
    await expect(claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })).resolves.toMatchObject({ outcome: 'claimed' })
  })

  it('rejects conflicting workflow event and focus authorities across categories', async () => {
    state.turns.push({
      id: 'cross-source', conversationId: 'conv-1', requestId: null,
      continuationBinding: null, continuationExecutionClaimedAt: null,
      status: 'done', executionMode: null,
    })
    state.workflows.set('workflow-browser', {
      id: 'workflow-browser', conversationId: 'conv-1', kind: 'browser_setup',
      status: 'active', state: 'running', stateVersion: 2, pendingActionId: null,
    })
    state.workflowEvents.push({
      id: 'event-cross', workflowRunId: 'workflow-1', detail: { turnId: 'cross-source' },
    })
    state.focuses.set('focus-cross', {
      id: 'focus-cross', conversationId: 'conv-1', status: 'active',
      kind: 'browser_setup', workflowRunId: 'workflow-browser',
      artifacts: { intakeTurnId: 'cross-source' },
    })
    await expect(buildSelfContinueBinding({
      conversationId: 'conv-1', sourceTurnId: 'cross-source',
    })).rejects.toMatchObject({ code: 'continuation_self_source_ambiguous' })
  })

  it('rejects a handcrafted deadline binding without persisted authority', async () => {
    expect(() => continuationRequestId({
      v: 1,
      origin: 'self_continue',
      source: { kind: 'turn', id: 'unbound-source' },
      conversationId: 'conv-1',
      domain: 'generic',
      event: 'deadline_resume',
      directive: { kind: 'deadline_resume', version: 1 },
      expected: { sourceStatus: ['running', 'done'] },
    })).toThrowError(/selfContinueAuthority/)
  })

  it('fails claim closed if the exact workflow event is retargeted after bind', async () => {
    state.turns.push({
      id: 'tamper-source', conversationId: 'conv-1', requestId: null,
      continuationBinding: null, continuationExecutionClaimedAt: null,
      status: 'done', executionMode: null,
    })
    state.workflows.set('browser-workflow', {
      id: 'browser-workflow', conversationId: 'conv-1', kind: 'browser_setup',
      status: 'active', state: 'deadline_paused', stateVersion: 2,
      pendingActionId: null,
    })
    state.workflowEvents.push({
      id: 'event-tamper', workflowRunId: 'browser-workflow',
      detail: { turnId: 'tamper-source' },
    })
    const binding = await buildSelfContinueBinding({
      conversationId: 'conv-1', sourceTurnId: 'tamper-source',
    })
    const bound = await bindContinuationTurn({ binding })
    state.workflowEvents[0].detail = { turnId: 'other-turn' }
    await expect(claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })).rejects.toMatchObject({ code: 'continuation_self_authority_mismatch' })
  })

  it('creates once and duplicate callbacks observe the exact same immutable turn', async () => {
    const first = await bindContinuationTurn({ binding: SEO_BINDING, executionMode: 'worker' })
    const second = await bindContinuationTurn({ binding: structuredClone(SEO_BINDING), executionMode: 'inline' })

    expect(first).toMatchObject({ created: true, status: 'running' })
    expect(second).toEqual({ ...first, created: false })
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0].continuationBinding).toEqual(SEO_BINDING)
  })

  it('never overwrites a preferred turn that already belongs to another source', async () => {
    state.turns.push({
      id: 'progress-turn', conversationId: 'conv-1', requestId: 'other',
      continuationBinding: { v: 1, source: { kind: 'pending_action', id: 'other' } },
      continuationExecutionClaimedAt: null, status: 'running', executionMode: null,
    })
    const result = await bindContinuationTurn({ binding: SEO_BINDING, preferredTurnId: 'progress-turn' })
    expect(result.turnId).not.toBe('progress-turn')
    expect(state.turns.find((row) => row.id === 'progress-turn')?.requestId).toBe('other')
  })

  it('observes stored authority when mutable workflow/status preconditions advanced', async () => {
    const first = await bindContinuationTurn({ binding: SEO_BINDING })
    state.workflows.get('workflow-1')!.stateVersion = 5
    const replay: ContinuationBindingV1 = {
      ...SEO_BINDING,
      expected: {
        ...SEO_BINDING.expected,
        sourceStatus: ['executed', 'delivered'],
        workflowStateVersion: 5,
      },
    }
    const second = await bindContinuationTurn({ binding: replay })

    expect(second).toEqual({ ...first, created: false })
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0].continuationBinding).toEqual(SEO_BINDING)
  })
})

describe('source validation and execution claim', () => {
  it.each([
    ['wrong conversation', { conversationId: 'conv-2' }, 'continuation_source_conversation_mismatch'],
    ['wrong domain', { domain: 'creative' }, 'continuation_source_domain_mismatch'],
    ['wrong status', { expected: { ...SEO_BINDING.expected, sourceStatus: ['approved'] } }, 'continuation_source_status_mismatch'],
  ])('rejects %s before a turn is created', async (_label, patch, code) => {
    const binding = { ...SEO_BINDING, ...patch } as ContinuationBindingV1
    await expect(bindContinuationTurn({ binding })).rejects.toMatchObject({ code } satisfies Partial<ContinuationBindingError>)
    expect(state.turns).toHaveLength(0)
  })

  it('requires the delivered artifact outbox receipt for artifact_delivered', async () => {
    state.outboxes.length = 0
    await expect(bindContinuationTurn({ binding: SEO_BINDING })).rejects.toMatchObject({
      code: 'continuation_delivery_not_ready',
    })
  })

  it('requires the deterministic native image message before an image continuation can bind', async () => {
    state.actions.set('image-1', {
      id: 'image-1', conversationId: 'conv-1', type: 'image_gen', status: 'executed',
      workflowRunId: null, result: { storagePath: 'generated/image.png' },
    })
    const imageBinding: ContinuationBindingV1 = {
      v: 1,
      origin: 'job_result',
      source: { kind: 'pending_action', id: 'image-1' },
      conversationId: 'conv-1',
      domain: 'creative',
      event: 'artifact_delivered',
      directive: { kind: 'image_artifact_delivered', version: 1 },
      expected: {
        sourceStatus: ['executed'], sourceType: 'image_gen', deliveryState: 'message_delivered',
      },
    }
    await expect(bindContinuationTurn({ binding: imageBinding })).rejects.toMatchObject({
      code: 'continuation_delivery_not_ready',
    })
    state.messages.set('image-message', {
      id: 'image-message', conversationId: 'conv-1', role: 'assistant',
      clientRequestId: 'job-result:image:image-1', content: [{ type: 'file_ref', path: 'generated/image.png' }],
    })
    const bound = await bindContinuationTurn({ binding: imageBinding })
    const claimed = await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    expect(claimed.directive).toContain('Never regenerate it')
  })

  it('admits exactly one executor and every duplicate observes it', async () => {
    const bound = await bindContinuationTurn({ binding: SEO_BINDING })
    const [a, b] = await Promise.all([
      claimContinuationExecution({
        conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
      }),
      claimContinuationExecution({
        conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
      }),
    ])
    expect([a.outcome, b.outcome].sort()).toEqual(['claimed', 'observe'])
    expect(renderContinuationDirective(a.binding ?? b.binding!)).toContain('Audit action action-1')
  })

  it('reclaims a stale claim after executor loss, exactly once', async () => {
    // Codex P1 (PR #847): the claim was a one-way latch — an executor that died
    // after claiming left the turn `running` forever, and every retry observed.
    const bound = await bindContinuationTurn({ binding: SEO_BINDING })
    const first = await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    expect(first.outcome).toBe('claimed')

    // Simulate executor death: the claim timestamp ages past the lease with no
    // terminal event; the turn is still running.
    const row = state.turns.find((t) => t.id === bound.turnId)!
    row.continuationExecutionClaimedAt =
      new Date(Date.now() - CONTINUATION_EXECUTION_LEASE_MS - 60_000)

    const [a, b] = await Promise.all([
      claimContinuationExecution({
        conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
      }),
      claimContinuationExecution({
        conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
      }),
    ])
    expect([a.outcome, b.outcome].sort()).toEqual(['claimed', 'observe'])
    // the winner refreshed the lease
    expect(row.continuationExecutionClaimedAt!.getTime())
      .toBeGreaterThan(Date.now() - 10_000)
  })

  it('a fresh claim is presumed live and still observes', async () => {
    const bound = await bindContinuationTurn({ binding: SEO_BINDING })
    await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    const retry = await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    expect(retry.outcome).toBe('observe')
  })

  it('never reclaims a terminal turn, however stale the claim', async () => {
    const bound = await bindContinuationTurn({ binding: SEO_BINDING })
    await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    const row = state.turns.find((t) => t.id === bound.turnId)!
    row.status = 'done'
    row.continuationExecutionClaimedAt =
      new Date(Date.now() - CONTINUATION_EXECUTION_LEASE_MS - 60_000)
    const retry = await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    expect(retry.outcome).toBe('observe')
    expect(retry.status).toBe('done')
  })

  it('loads a valid binding, distinguishes absence, and fails malformed rows closed', async () => {
    const bound = await bindContinuationTurn({ binding: SEO_BINDING })
    await expect(loadContinuationBindingForTurn('conv-1', bound.turnId)).resolves.toMatchObject({
      state: 'bound', binding: SEO_BINDING,
    })
    await expect(loadContinuationBindingForTurn('conv-1', 'missing')).resolves.toEqual({ state: 'absent' })
    state.turns[0].continuationBinding = { v: 9 }
    await expect(loadContinuationBindingForTurn('conv-1', bound.turnId)).resolves.toMatchObject({ state: 'invalid' })
  })

  it('moves an open task to running only when execution actually wins', async () => {
    state.openTasks.set('task-1', {
      id: 'task-1', conversationId: 'conv-1', status: 'open', kind: 'chat_followup',
      workflowRunId: null, pendingActionId: null, resumeNote: 'ঠিক পরের ধাপ থেকে audit চালাও',
    })
    const binding: ContinuationBindingV1 = {
      v: 1,
      origin: 'open_task',
      source: { kind: 'open_task', id: 'task-1' },
      conversationId: 'conv-1',
      domain: 'generic',
      event: 'resume_requested',
      directive: { kind: 'open_task_resume', version: 1 },
      expected: { sourceStatus: ['open', 'running'] },
    }
    const bound = await bindContinuationTurn({ binding })
    expect(state.openTasks.get('task-1')?.status).toBe('open')

    const claimed = await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    expect(claimed.outcome).toBe('claimed')
    expect(claimed.directive).toContain('ঠিক পরের ধাপ')
    expect(state.openTasks.get('task-1')?.status).toBe('running')
  })

  it('observes the same open-task turn after its first executor advanced the source status', async () => {
    state.openTasks.set('task-2', {
      id: 'task-2', conversationId: 'conv-1', status: 'open', kind: 'chat_followup',
      workflowRunId: null, pendingActionId: null, resumeNote: 'resume exact task',
    })
    const binding: ContinuationBindingV1 = {
      v: 1,
      origin: 'open_task',
      source: { kind: 'open_task', id: 'task-2' },
      conversationId: 'conv-1',
      domain: 'generic',
      event: 'resume_requested',
      directive: { kind: 'open_task_resume', version: 1 },
      // Deliberately captures the create-time state only. Duplicate lookup must
      // not re-validate this after the first executor moves it to running.
      expected: { sourceStatus: ['open'] },
    }
    const first = await bindContinuationTurn({ binding })
    await claimContinuationExecution({
      conversationId: 'conv-1', turnId: first.turnId, requestId: first.requestId,
    })
    expect(state.openTasks.get('task-2')?.status).toBe('running')

    await expect(bindContinuationTurn({ binding })).resolves.toEqual({ ...first, created: false })
    await expect(findExistingBoundContinuationTurn({
      conversationId: 'conv-1',
      origin: 'open_task',
      source: { kind: 'open_task', id: 'task-2' },
      event: 'resume_requested',
    })).resolves.toMatchObject({
      turnId: first.turnId, created: false, binding, executionClaimed: true,
    })
    expect(state.turns.filter((row) => row.requestId === first.requestId)).toHaveLength(1)
  })

  it('never creates a continuation during existing-binding replay preflight', async () => {
    state.openTasks.set('terminal-unclaimed', {
      id: 'terminal-unclaimed', conversationId: 'conv-1', status: 'done', kind: 'chat_followup',
      workflowRunId: null, pendingActionId: null, resumeNote: 'already terminal',
    })
    await expect(findExistingBoundContinuationTurn({
      conversationId: 'conv-1',
      origin: 'open_task',
      source: { kind: 'open_task', id: 'terminal-unclaimed' },
      event: 'resume_requested',
    })).resolves.toBeNull()
    expect(state.turns).toHaveLength(0)
  })

  it('exposes an unclaimed bound turn so transport retry can safely enqueue it', async () => {
    state.openTasks.set('task-deferred', {
      id: 'task-deferred', conversationId: 'conv-1', status: 'open', kind: 'chat_followup',
      workflowRunId: null, pendingActionId: null, resumeNote: 'resume after queue outage',
    })
    const binding: ContinuationBindingV1 = {
      v: 1,
      origin: 'open_task',
      source: { kind: 'open_task', id: 'task-deferred' },
      conversationId: 'conv-1',
      domain: 'generic',
      event: 'resume_requested',
      directive: { kind: 'open_task_resume', version: 1 },
      expected: { sourceStatus: ['open'], sourceType: 'chat_followup' },
    }
    const first = await bindContinuationTurn({ binding })

    await expect(findExistingBoundContinuationTurn({
      conversationId: 'conv-1',
      origin: 'open_task',
      source: { kind: 'open_task', id: 'task-deferred' },
      event: 'resume_requested',
    })).resolves.toMatchObject({
      turnId: first.turnId,
      requestId: first.requestId,
      status: 'running',
      executionClaimed: false,
      binding,
    })
    expect(state.openTasks.get('task-deferred')?.status).toBe('open')
  })

  it('atomically cancels an unclaimed zero-event turn after its source became terminal', async () => {
    state.openTasks.set('task-orphan', {
      id: 'task-orphan', conversationId: 'conv-1', status: 'open', kind: 'chat_followup',
      workflowRunId: null, pendingActionId: null, resumeNote: 'never executed',
    })
    const binding: ContinuationBindingV1 = {
      v: 1,
      origin: 'open_task',
      source: { kind: 'open_task', id: 'task-orphan' },
      conversationId: 'conv-1',
      domain: 'generic',
      event: 'resume_requested',
      directive: { kind: 'open_task_resume', version: 1 },
      expected: { sourceStatus: ['open'], sourceType: 'chat_followup' },
    }
    const bound = await bindContinuationTurn({ binding })
    state.openTasks.get('task-orphan')!.status = 'done'

    await expect(settleUnclaimedOpenTaskContinuation({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })).resolves.toEqual({
      settled: true, status: 'canceled', executionClaimed: false, sourceStatus: 'done',
    })
    expect(state.turns.find((row) => row.id === bound.turnId)?.status).toBe('canceled')
    await expect(settleUnclaimedOpenTaskContinuation({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })).resolves.toEqual({
      settled: false, status: 'canceled', executionClaimed: false, sourceStatus: 'done',
    })
  })

  it('never cancels a turn after a concurrent execution claim won', async () => {
    state.openTasks.set('task-claimed-race', {
      id: 'task-claimed-race', conversationId: 'conv-1', status: 'open', kind: 'chat_followup',
      workflowRunId: null, pendingActionId: null, resumeNote: 'exact task',
    })
    const binding: ContinuationBindingV1 = {
      v: 1,
      origin: 'open_task',
      source: { kind: 'open_task', id: 'task-claimed-race' },
      conversationId: 'conv-1', domain: 'generic', event: 'resume_requested',
      directive: { kind: 'open_task_resume', version: 1 },
      expected: { sourceStatus: ['open'], sourceType: 'chat_followup' },
    }
    const bound = await bindContinuationTurn({ binding })
    await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    state.openTasks.get('task-claimed-race')!.status = 'done'

    await expect(settleUnclaimedOpenTaskContinuation({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })).resolves.toEqual({
      settled: false, status: 'running', executionClaimed: true, sourceStatus: 'done',
    })
    expect(state.turns.find((row) => row.id === bound.turnId)?.status).toBe('running')
  })

  it('enforces the persisted open-task kind when the binding names one', async () => {
    state.openTasks.set('task-kind', {
      id: 'task-kind', conversationId: 'conv-1', status: 'open', kind: 'chat_followup',
      workflowRunId: null, pendingActionId: null, resumeNote: 'resume',
    })
    await expect(bindContinuationTurn({
      binding: {
        v: 1,
        origin: 'open_task',
        source: { kind: 'open_task', id: 'task-kind' },
        conversationId: 'conv-1',
        domain: 'generic',
        event: 'resume_requested',
        directive: { kind: 'open_task_resume', version: 1 },
        expected: { sourceStatus: ['open'], sourceType: 'youtube_playback' },
      },
    })).rejects.toMatchObject({ code: 'continuation_source_type_mismatch' })
  })

  it('binds one persisted plan-step attempt, links its exact turn, and renders DB authority', async () => {
    state.plans.set('plan-1', {
      id: 'plan-1', conversationId: 'conv-1', businessId: 'ALMA_LIFESTYLE',
      goal: 'example.test SEO ঠিক করো', status: 'executing', workflowRunId: null,
      autodriveState: 'driving', originTurnId: 'origin-turn',
    })
    state.planSteps.set('step-1', {
      id: 'step-1', planId: 'plan-1', action: 'meta descriptions ঠিক করো',
      toolName: '__grind_fix', status: 'running', error: null, attemptCount: 0, turnId: null,
    })
    state.kv.set('grind_step:step-1', JSON.stringify({
      setId: 'set-1', kind: 'fix', family: 'missing_meta', fingerprints: ['home|missing_meta'],
    }))
    state.findingSets.set('set-1', { id: 'set-1', target: 'example.test' })
    state.messages.set('plan-steer', {
      id: 'plan-steer', conversationId: 'conv-1', role: 'user',
      content: [{ type: 'text', text: 'homepage আগে করো' }],
      usage: { steeringConsumedBy: 'step-1' }, createdAt: new Date(),
    })
    state.turns.push({
      id: 'plan-turn', conversationId: 'conv-1', requestId: null,
      continuationBinding: null, continuationExecutionClaimedAt: null,
      status: 'running', executionMode: 'worker',
    })

    const binding = await buildPlanStepContinuationBinding({
      stepId: 'step-1', conversationId: 'conv-1', steeringMessageIds: ['plan-steer'],
    })
    expect(binding).toMatchObject({
      origin: 'plan_driver', source: { kind: 'plan_step', id: 'step-1' },
      planId: 'plan-1', subidentity: 'attempt-1', domain: 'seo',
      directive: { kind: 'plan_step_execute', version: 1 },
    })
    expect(continuationRequestId(binding)).toBe(
      'continuation:v1:plan_driver:plan_step:step-1:step_dispatch:attempt-1',
    )
    const bound = await bindContinuationTurn({ binding, preferredTurnId: 'plan-turn' })
    expect(bound.turnId).toBe('plan-turn')
    expect(state.planSteps.get('step-1')?.turnId).toBe('plan-turn')

    const claim = await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    expect(claim.outcome).toBe('claimed')
    expect(claim.directive).toContain('meta descriptions ঠিক করো')
    expect(claim.directive).toContain('homepage আগে করো')
    expect(claim.directive).toContain('PROPOSAL MODE')
  })

  it('binds specialist brief index from the pending action and observes its terminal replay', async () => {
    state.actions.set('graph-1', {
      id: 'graph-1', conversationId: 'conv-1', type: 'agent_graph_run', status: 'approved',
      workflowRunId: null,
      payload: { briefs: [{ role: 'seo_researcher', task: 'canonical tags যাচাই করো' }] },
      result: { graphRunProgress: { completed: [], findings: [], status: 'running' } },
    })
    const first = await createOrReuseSpecialistBriefContinuation({
      pendingActionId: 'graph-1', briefIndex: 0,
    })
    expect(first.requestId).toBe(
      'continuation:v1:specialist:pending_action:graph-1:specialist_dispatch:brief-0',
    )
    const claim = await claimContinuationExecution({
      conversationId: 'conv-1', turnId: first.turnId, requestId: first.requestId,
    })
    expect(claim.directive).toContain('role: seo_researcher')
    expect(claim.directive).toContain('canonical tags যাচাই করো')

    await expect(createOrReuseSpecialistBriefContinuation({
      pendingActionId: 'graph-1', briefIndex: 1,
    })).rejects.toMatchObject({ code: 'continuation_specialist_brief_missing' })

    state.turns.find((row) => row.id === first.turnId)!.status = 'done'
    state.actions.get('graph-1')!.status = 'executed'
    state.actions.get('graph-1')!.result = {
      graphRunProgress: { completed: [0], findings: [], status: 'done' },
    }
    await expect(createOrReuseSpecialistBriefContinuation({
      pendingActionId: 'graph-1', briefIndex: 0,
    })).resolves.toMatchObject({ turnId: first.turnId, created: false, status: 'done' })
  })

  it('rejects specialist brief mutation after binding and before execution claim', async () => {
    state.actions.set('graph-mutated', {
      id: 'graph-mutated', conversationId: 'conv-1', type: 'agent_graph_run', status: 'approved',
      workflowRunId: null,
      payload: { briefs: [{ role: 'researcher', task: 'original persisted task' }] },
      result: { graphRunProgress: { completed: [] } },
    })
    const bound = await createOrReuseSpecialistBriefContinuation({
      pendingActionId: 'graph-mutated', briefIndex: 0,
    })
    state.actions.get('graph-mutated')!.payload = {
      briefs: [{ role: 'researcher', task: 'tampered replacement task' }],
    }
    await expect(claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })).rejects.toMatchObject({ code: 'continuation_specialist_brief_mismatch' })
    expect(state.turns.find((row) => row.id === bound.turnId)?.continuationExecutionClaimedAt).toBeNull()
  })

  it('rehydrates exact persisted last-moment steering rows and rejects id tampering', async () => {
    state.turns.push({
      id: 'predecessor', conversationId: 'conv-1', requestId: null,
      continuationBinding: null, continuationExecutionClaimedAt: null,
      status: 'done', executionMode: null,
    })
    state.messages.set('steer-1', {
      id: 'steer-1', conversationId: 'conv-1', role: 'user',
      content: [{ type: 'text', text: 'শুধু SEO audit চালিয়ে যাও' }],
      usage: { steering: { targetTurnId: 'predecessor', status: 'consumed' } },
    })
    const steeringBinding: ContinuationBindingV1 = {
      v: 1,
      origin: 'steering',
      source: { kind: 'turn', id: 'predecessor' },
      conversationId: 'conv-1',
      domain: 'generic',
      event: 'steering_applied',
      directive: { kind: 'owner_steering', version: 1 },
      expected: { sourceStatus: ['done'] },
      steeringMessageIds: ['steer-1'],
    }
    const bound = await bindContinuationTurn({ binding: steeringBinding })
    const claim = await claimContinuationExecution({
      conversationId: 'conv-1', turnId: bound.turnId, requestId: bound.requestId,
    })
    expect(claim.outcome).toBe('claimed')
    expect(claim.directive).toContain('শুধু SEO audit চালিয়ে যাও')

    const conflicting: ContinuationBindingV1 = {
      ...steeringBinding,
      steeringMessageIds: ['steer-tampered'],
    }
    await expect(bindContinuationTurn({ binding: conflicting })).rejects.toMatchObject({
      code: 'continuation_binding_conflict',
    })
  })

  it('rejects steering rows bound to another predecessor before creating a turn', async () => {
    state.turns.push({
      id: 'predecessor', conversationId: 'conv-1', requestId: null,
      continuationBinding: null, continuationExecutionClaimedAt: null,
      status: 'done', executionMode: null,
    })
    state.messages.set('steer-wrong', {
      id: 'steer-wrong', conversationId: 'conv-1', role: 'user',
      content: [{ type: 'text', text: 'continue' }],
      usage: { steering: { targetTurnId: 'other-turn', status: 'queued' } },
    })
    await expect(bindContinuationTurn({
      binding: {
        v: 1,
        origin: 'steering',
        source: { kind: 'turn', id: 'predecessor' },
        conversationId: 'conv-1',
        domain: 'generic',
        event: 'steering_applied',
        directive: { kind: 'owner_steering', version: 1 },
        expected: { sourceStatus: ['done'] },
        steeringMessageIds: ['steer-wrong'],
      },
    })).rejects.toMatchObject({ code: 'continuation_steering_source_mismatch' })
  })

})
