import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { buildClientReportHtml } from '@/agent/lib/seo-report'

type Row = Record<string, unknown> & { id: string }

const state = vi.hoisted(() => ({
  action: null as Row | null,
  outboxes: [] as Row[],
  ledger: [] as Row[],
  artifacts: [] as Row[],
  messages: [] as Row[],
  uploads: new Map<string, Buffer>(),
  txSeq: 0,
  activeTx: null as number | null,
  txOps: [] as Array<{ tx: number | null; op: string }>,
  conversationUpdates: [] as Array<Record<string, unknown>>,
  repairCandidates: [] as Array<{ id: string; conversationId: string }>,
  failMessageCreateOnce: false,
  failSettleOnce: false,
  unansweredAsk: true,
  enqueueContinuation: vi.fn(),
  workflowRelease: vi.fn(),
  workflowSync: vi.fn(),
  postAssistantMessage: vi.fn(),
}))

const AUDIT = {
  url: 'https://example.test',
  crawledAt: '2026-08-23T00:00:00.000Z',
  score: 61,
  counts: { critical: 0, high: 1, medium: 0, low: 0 },
  pagesCrawled: 4,
  elapsedMs: 1000,
  avgTtfbMs: 100,
  sitemap: { ok: true, count: 7 },
  siteChecks: { issues: [] },
  pages: [{
    url: 'https://example.test/',
    status: 200,
    title: 'Example',
    titleLength: 7,
    metaDescLength: 0,
    h1Count: 1,
    wordCount: 100,
    ttfbMs: 100,
    issues: [{ severity: 'high' as const, code: 'missing_meta', detail: 'meta description নেই' }],
  }],
}

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/agent/lib/storage', () => ({
  agentStorageDownload: vi.fn(async () => Buffer.from(JSON.stringify(AUDIT))),
  agentStorageUpload: vi.fn(async (path: string, body: Buffer) => {
    state.uploads.set(path, body)
    return { bucket: 'agent-files', objectPath: path }
  }),
  agentStorageSignedUrl: vi.fn(async (path: string) => `https://signed.test/${path}`),
}))
vi.mock('@/agent/lib/approval-continuation', () => ({ enqueueAgentContinuation: state.enqueueContinuation }))
vi.mock('@/agent/lib/planner', () => ({
  settlePlanStepsLinkedToPendingAction: vi.fn(async () => {
    if (state.failSettleOnce) {
      state.failSettleOnce = false
      throw new Error('crash_after_terminal_enqueue')
    }
  }),
}))
vi.mock('@/agent/lib/turn-status', () => ({ finalizeTurnIfRunning: vi.fn() }))
vi.mock('@/agent/lib/outbound-call-tracking', () => ({ buildOutboundDialMessage: vi.fn() }))
vi.mock('@/agent/lib/telegram-owner-notify', () => ({ sendOwnerText: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/agent/lib/job-result-message-policy', () => ({
  shouldEmitGenericJobSuccess: vi.fn(() => false),
  shouldResumeAgentAfterImageWorkflow: vi.fn(() => false),
  shouldResumeAgentAfterJob: vi.fn((type: string, status: string) => type === 'seo_audit' && status === 'success'),
}))
vi.mock('@/agent/lib/job-delivery', () => ({
  buildFallbackDeliveryMessage: vi.fn(() => 'legacy'),
  hasUnansweredAskCard: vi.fn(async () => state.unansweredAsk),
  isDeliverableJobType: vi.fn((type: string) => type === 'seo_audit'),
  markDelivered: vi.fn(),
  markDeliveryPending: vi.fn(),
  postAssistantMessage: state.postAssistantMessage,
  ownerFileLink: (path: string) => `https://alma.test/api/assistant/files?path=${encodeURIComponent(path)}&redirect=1`,
}))
vi.mock('@/agent/lib/workflow-run', () => ({
  releaseWorkflowLease: state.workflowRelease,
  syncWorkflowWithPendingAction: state.workflowSync,
  getWorkflowRunByPendingAction: vi.fn(async () => null),
}))
vi.mock('@/agent/lib/checkpoint', () => ({
  writeCheckpoint: vi.fn(async () => 'checkpoint'),
  resolveCheckpointByTaskRef: vi.fn(),
}))

vi.mock('@/lib/prisma', () => {
  const log = (op: string) => state.txOps.push({ tx: state.activeTx, op })
  const outboxMatch = (where: Record<string, unknown>) => state.outboxes.find((row) => (
    (!where.id || row.id === where.id)
    && (!where.deliveryKey || row.deliveryKey === where.deliveryKey)
    && (!where.sourceId || row.sourceId === where.sourceId)
  )) ?? null
  const prisma = {
    agentPendingAction: {
      findUnique: vi.fn(async () => state.action),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        log(`action:${String(data.status ?? 'update')}`)
        Object.assign(state.action!, data)
        return state.action
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    agentArtifactDeliveryOutbox: {
      upsert: vi.fn(async ({ where, create, update }: { where: { deliveryKey: string }; create: Row; update: Row }) => {
        let row = state.outboxes.find((candidate) => candidate.deliveryKey === where.deliveryKey)
        if (!row) {
          row = { ...create, id: 'outbox-1', attempts: 0, maxAttempts: 8, leaseUntil: null, availableAt: new Date() }
          state.outboxes.push(row)
          log('outbox:enqueued')
        } else Object.assign(row, update)
        return row
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => outboxMatch(where)),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => outboxMatch(where)),
      findMany: vi.fn(async ({ take }: { take: number }) => state.outboxes
        .filter((row) => ['pending', 'retry', 'processing'].includes(String(row.status)))
        .slice(0, take)
        .map((row) => ({ sourceId: row.sourceId }))),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = outboxMatch(where)
        if (!row || row.status === 'delivered') return { count: 0 }
        Object.assign(row, data, {
          attempts: Number(row.attempts ?? 0) + (typeof data.attempts === 'object' ? 1 : 0),
        })
        return { count: 1 }
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
        const row = outboxMatch(where)!
        Object.assign(row, data)
        return row
      }),
    },
    agentArtifactDeliveryLedger: {
      upsert: vi.fn(async ({ where, create }: { where: { outboxId_milestone: { outboxId: string; milestone: string } }; create: Row }) => {
        const key = where.outboxId_milestone
        let row = state.ledger.find((candidate) => candidate.outboxId === key.outboxId && candidate.milestone === key.milestone)
        if (!row) {
          row = { ...create, id: `ledger-${state.ledger.length + 1}` }
          state.ledger.push(row)
        }
        return row
      }),
    },
    agentArtifact: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.artifacts.find((row) => (
        (where.id && row.id === where.id) || (where.deliveryKey && row.deliveryKey === where.deliveryKey)
      )) ?? null),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.artifacts.find((row) => (
        (!where.conversationId || row.conversationId === where.conversationId)
        && (!where.title || row.title === where.title)
        && (!where.type || row.type === where.type)
        && (!(where.deliveryKey === null) || row.deliveryKey == null)
      )) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { ...data, id: `artifact-${state.artifacts.length + 1}`, version: data.version ?? 1, messageId: null }
        state.artifacts.push(row)
        return row
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = state.artifacts.find((candidate) => candidate.id === where.id)!
        Object.assign(row, data)
        return row
      }),
    },
    agentMessage: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.messages.find((row) => (
        (where.id && row.id === where.id) || (where.clientRequestId && row.clientRequestId === where.clientRequestId)
      )) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.messages.filter((row) => (
        (!where.conversationId || row.conversationId === where.conversationId)
        && (!where.role || row.role === where.role)
      ))),
      create: vi.fn(async ({ data }: { data: Row }) => {
        if (state.failMessageCreateOnce) {
          state.failMessageCreateOnce = false
          throw new Error('message_store_unavailable')
        }
        const row = { ...data, id: data.id ?? `message-${state.messages.length + 1}` }
        state.messages.push(row)
        return row
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = state.messages.find((candidate) => candidate.id === where.id)!
        Object.assign(row, data)
        return row
      }),
      upsert: vi.fn(),
    },
    agentConversation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
        state.action && where.id === state.action.conversationId ? { id: where.id } : null
      )),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.conversationUpdates.push(data)
        return {}
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const previous = state.activeTx
      state.activeTx = ++state.txSeq
      try { return await fn(prisma) } finally { state.activeTx = previous }
    }),
    $queryRaw: vi.fn(async () => [...state.repairCandidates]),
  }
  return { prisma }
})

import { POST } from '@/app/api/assistant/internal/job-result/route'
import { runSeoArtifactDeliverySweep } from '@/agent/lib/seo-artifact-outbox'

const originalToken = process.env.AGENT_INTERNAL_TOKEN
const originalFlag = process.env.AGENT_ARTIFACT_OUTBOX

function action(status = 'approved'): Row {
  return {
    id: '2617c17a-079f-4f6b-b49e-060e23f4380a',
    type: 'seo_audit',
    status,
    summary: 'SEO audit: example.test',
    conversationId: '9598d574-4587-4449-abc2-7c6ba47407f2',
    payload: { url: 'https://example.test' },
    result: status === 'executed' ? { artifacts: [`seo-audits/2617c17a-079f-4f6b-b49e-060e23f4380a/audit.json`] } : null,
    jobResultPending: false,
    resolvedAt: status === 'executed' ? new Date('2026-08-23T00:00:00.000Z') : null,
  }
}

function request() {
  return new NextRequest('https://alma.test/api/assistant/internal/job-result', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      pendingActionId: state.action!.id,
      status: 'success',
      data: {
        artifacts: [
          'seo-audits/2617c17a-079f-4f6b-b49e-060e23f4380a/audit.json',
          'seo-audits/2617c17a-079f-4f6b-b49e-060e23f4380a/evidence/homepage.png',
        ],
      },
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.action = action()
  state.outboxes.length = 0
  state.ledger.length = 0
  state.artifacts.length = 0
  state.messages.length = 0
  state.uploads.clear()
  state.txSeq = 0
  state.activeTx = null
  state.txOps.length = 0
  state.conversationUpdates.length = 0
  state.repairCandidates.length = 0
  state.failMessageCreateOnce = false
  state.failSettleOnce = false
  state.unansweredAsk = true
  process.env.AGENT_INTERNAL_TOKEN = 'test-token'
  process.env.AGENT_ARTIFACT_OUTBOX = 'true'
})

afterEach(() => {
  if (originalToken === undefined) delete process.env.AGENT_INTERNAL_TOKEN
  else process.env.AGENT_INTERNAL_TOKEN = originalToken
  if (originalFlag === undefined) delete process.env.AGENT_ARTIFACT_OUTBOX
  else process.env.AGENT_ARTIFACT_OUTBOX = originalFlag
})

describe('SEO job-result artifact outbox integration', () => {
  it('commits terminal source + enqueue in one transaction, then links one canonical card message', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)

    const terminal = state.txOps.find((entry) => entry.op === 'action:executed')
    const enqueued = state.txOps.find((entry) => entry.op === 'outbox:enqueued')
    expect(terminal?.tx).toBeTypeOf('number')
    expect(enqueued?.tx).toBe(terminal?.tx)
    expect(state.outboxes).toHaveLength(1)
    expect(state.outboxes[0]).toMatchObject({ status: 'delivered', artifactId: state.artifacts[0].id, messageId: state.messages[0].id })
    expect(state.uploads.size).toBe(3)
    expect((state.outboxes[0].storageReceipts as unknown[])).toHaveLength(4)
    expect((state.action?.result as { artifacts: string[] }).artifacts).toEqual(expect.arrayContaining([
      'seo-audits/2617c17a-079f-4f6b-b49e-060e23f4380a/evidence/homepage.png',
      'seo-audits/2617c17a-079f-4f6b-b49e-060e23f4380a/report.html',
      'seo-audits/2617c17a-079f-4f6b-b49e-060e23f4380a/report.md',
      'seo-audits/2617c17a-079f-4f6b-b49e-060e23f4380a/issues.csv',
      'seo-audits/2617c17a-079f-4f6b-b49e-060e23f4380a/audit.json',
    ]))
    expect(state.artifacts).toHaveLength(1)
    expect(state.messages).toHaveLength(1)
    expect(state.artifacts[0].messageId).toBe(state.messages[0].id)
    expect((state.messages[0].usage as Record<string, unknown>).artifactSaved).toMatchObject({
      type: 'artifact_saved', id: state.artifacts[0].id, artifactType: 'html',
    })
    expect(state.ledger.map((row) => row.milestone)).toEqual(expect.arrayContaining([
      'enqueued', 'storage_persisted', 'artifact_linked', 'message_linked', 'artifact_saved', 'delivered',
    ]))
    expect(state.postAssistantMessage).not.toHaveBeenCalled()
    expect(state.conversationUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ updatedAt: expect.any(Date), lastMessageAt: expect.any(Date) }),
    ]))
  })

  it('duplicate executed callback replays a partial outbox and converges instead of fast-acking', async () => {
    state.failMessageCreateOnce = true
    const first = await POST(request())
    expect(first.status).toBe(503)
    expect(state.action?.status).toBe('executed')
    expect(state.outboxes[0].status).toBe('retry')
    expect(state.artifacts).toHaveLength(1)
    expect(state.messages).toHaveLength(0)

    // Make the retry due now. The second callback enters the route's early
    // executed branch and must reconcile the same logical artifact/message.
    state.outboxes[0].availableAt = new Date(0)
    const replay = await POST(request())
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      ok: true, idempotent: true, status: 'executed', artifactDelivery: 'delivered',
    })
    expect(state.outboxes).toHaveLength(1)
    expect(state.artifacts).toHaveLength(1)
    expect(state.messages).toHaveLength(1)
    expect(state.artifacts[0].messageId).toBe(state.messages[0].id)
  })

  it('reconciles workflow and SEO continuation after a crash just past terminal+enqueue', async () => {
    state.failSettleOnce = true
    state.unansweredAsk = false

    await expect(POST(request())).rejects.toThrow('crash_after_terminal_enqueue')
    expect(state.action?.status).toBe('executed')
    expect(state.outboxes).toHaveLength(1)
    expect(state.outboxes[0].status).toBe('pending')
    expect(state.workflowRelease).not.toHaveBeenCalled()

    const replay = await POST(request())
    expect(replay.status).toBe(200)
    expect(state.workflowRelease).toHaveBeenCalledWith(state.action?.id)
    expect(state.workflowSync).toHaveBeenCalledWith(state.action?.id, 'worker')
    expect(state.enqueueContinuation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: state.action?.conversationId,
      force: true,
      binding: expect.objectContaining({
        v: 1,
        origin: 'job_result',
        source: { kind: 'pending_action', id: state.action?.id },
        conversationId: state.action?.conversationId,
        domain: 'seo',
        event: 'artifact_delivered',
        directive: { kind: 'seo_artifact_delivered', version: 1 },
        expected: expect.objectContaining({
          sourceStatus: ['executed'],
          sourceType: 'seo_audit',
          deliveryState: 'delivered',
        }),
      }),
    }))
    expect(state.outboxes).toHaveLength(1)
    expect(state.messages).toHaveLength(1)
  })

  it('terminalizes a hard-crashed final lease instead of stranding processing forever', async () => {
    state.action = action('executed')
    state.outboxes.push({
      id: 'outbox-exhausted',
      deliveryKey: `artifact:pending_action:${state.action.id}:seo-dashboard:v1`,
      sourceKind: 'pending_action',
      sourceId: state.action.id,
      conversationId: state.action.conversationId,
      logicalName: 'seo-dashboard',
      version: 1,
      status: 'processing',
      spec: { kind: 'seo_audit' },
      attempts: 8,
      maxAttempts: 8,
      availableAt: new Date(0),
      leaseUntil: new Date(0),
      leaseOwner: 'crashed-worker',
    })

    const response = await POST(request())
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      idempotent: true,
      artifactDelivery: 'dead',
      error: 'seo_artifact_delivery_dead',
    })
    expect(state.outboxes[0]).toMatchObject({
      status: 'dead',
      attempts: 8,
      leaseUntil: null,
      leaseOwner: null,
      lastError: 'lease_expired_after_max_attempts',
    })
    expect(state.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ milestone: 'dead', payload: expect.objectContaining({ attempts: 8 }) }),
    ]))
    expect(state.uploads.size).toBe(0)
    expect(state.artifacts).toHaveLength(0)
    expect(state.messages).toHaveLength(0)
  })

  it('repairs the incident-shaped historical spine without a worker callback and adopts both identities', async () => {
    const artifactId = '69f9c18b-7c8f-4cf9-8c16-c41e6d9ba037'
    const messageId = 'd588c6c5-acf0-480b-8f5b-42d40d75dcce'
    const prefix = `seo-audits/${state.action!.id}`
    state.action = {
      ...action('executed'),
      result: {
        artifacts: [`${prefix}/audit.json`],
        __delivery: { state: 'delivered', via: 'server_spine' },
      },
    }
    state.repairCandidates.push({ id: state.action.id, conversationId: String(state.action.conversationId) })
    const ownerLink = (path: string) => `https://alma.test/api/assistant/files?path=${encodeURIComponent(path)}&redirect=1`
    const summary = [
      'Boss, **example.test**-এর পূর্ণ SEO অডিট শেষ।',
      '',
      '**স্কোর: 61/100** · দেখা হয়েছে 4/7 পেজ (sitemap অনুযায়ী)',
      'সমস্যা: 🔴 0 · 🟠 1 · 🟡 0 · ⚪ 0',
      '',
      '**সবচেয়ে বড় সমস্যাগুলো:**',
      '- 🟠 গুরুতর meta description নেই — 1টা জায়গায়',
      '',
      'বিস্তারিত প্রমাণ, প্রতিটার সমাধান আর অগ্রাধিকার-প্ল্যান ড্যাশবোর্ডে (নিচের ফাইলে) আছে।',
    ].join('\n')
    const legacyText = `${summary}\n\n**ফাইল:**\n` + [
      `- [লাইভ ড্যাশবোর্ড (HTML)](${ownerLink(`${prefix}/report.html`)})`,
      `- [পুরো রিপোর্ট (md)](${ownerLink(`${prefix}/report.md`)})`,
      `- [সব issue (Excel/CSV)](${ownerLink(`${prefix}/issues.csv`)})`,
      `- [raw findings (json)](${ownerLink(`${prefix}/audit.json`)})`,
    ].join('\n')
    state.artifacts.push({
      id: artifactId,
      conversationId: state.action.conversationId,
      title: 'SEO অডিট ড্যাশবোর্ড — example.test',
      type: 'html',
      version: 1,
      content: buildClientReportHtml(AUDIT, { keywordsNote: null }),
      deliveryKey: null,
      messageId,
    })
    state.messages.push({
      id: messageId,
      conversationId: state.action.conversationId,
      role: 'assistant',
      clientRequestId: null,
      content: [{ type: 'text', text: legacyText }],
      usage: null,
      createdAt: new Date('2026-08-23T00:00:00.000Z'),
    })

    const result = await runSeoArtifactDeliverySweep(2)

    expect(result).toMatchObject({ repaired: 1, delivered: 1 })
    expect(state.artifacts).toHaveLength(1)
    expect(state.messages).toHaveLength(1)
    expect(state.artifacts[0]).toMatchObject({ id: artifactId, messageId, deliveryKey: expect.stringContaining(String(state.action.id)) })
    expect(state.messages[0]).toMatchObject({ id: messageId, clientRequestId: expect.stringContaining('artifact-delivery:') })
    expect(state.outboxes[0]).toMatchObject({ status: 'delivered', artifactId, messageId })
  })
})
