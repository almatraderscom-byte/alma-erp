import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const compositionHarness = vi.hoisted(() => {
  type Row = Record<string, any>
  const state = {
    token: null as null | {
      sub: string
      name: string
      email: string
      role: 'SUPER_ADMIN' | 'STAFF'
    },
    brand: {
      id: 'brand-alma',
      ownerId: 'owner-1',
      approvalSpendThresholdBdt: 100,
      name: 'ALMA Lifestyle',
    } as Row,
    roles: new Map<string, 'CREATOR' | 'REVIEWER'>([
      ['creator-1', 'CREATOR'],
      ['reviewer-1', 'REVIEWER'],
    ]),
    project: {} as Row,
    compositions: [] as Row[],
    versions: [] as Row[],
    batches: [] as Row[],
    operations: [] as Row[],
    rollbackPoints: [] as Row[],
    nodes: [] as Row[],
    transactionCalls: 0,
  }

  function matchesKind(value: unknown, expected: unknown): boolean {
    if (expected && typeof expected === 'object' && 'in' in expected) {
      return (expected as { in: string[] }).in.includes(String(value))
    }
    return expected == null || String(value) === String(expected)
  }

  const prisma: Row = {
    creativeBrandProfile: {
      findUnique: vi.fn(async ({ where }: Row) =>
        where.id === state.brand.id ? state.brand : null),
      upsert: vi.fn(async () => state.brand),
      findMany: vi.fn(async () => [state.brand]),
    },
    creativeStudioRoleAssignment: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const key = where.brandProfileId_userId
        const role = key?.brandProfileId === state.brand.id
          ? state.roles.get(String(key.userId))
          : null
        return role ? { ownerId: 'owner-1', role } : null
      }),
      findMany: vi.fn(async () => []),
    },
    creativeProject: {
      findUnique: vi.fn(async ({ where }: Row) =>
        where.id === state.project.id ? state.project : null),
    },
    creativeComposition: {
      findUnique: vi.fn(async ({ where }: Row) => {
        if (where.id) {
          return state.compositions.find((row) => row.id === where.id) ?? null
        }
        const key = where.ownerId_creationIdempotencyKey
        if (key) {
          return state.compositions.find((row) =>
            row.ownerId === key.ownerId
            && row.creationIdempotencyKey === key.creationIdempotencyKey) ?? null
        }
        return null
      }),
      findMany: vi.fn(async ({ where }: Row) => state.compositions
        .filter((row) => !row.archivedAt)
        .filter((row) => !where.projectId || row.projectId === where.projectId)
        .filter((row) => !where.brandProfileId?.in
          || where.brandProfileId.in.includes(row.brandProfileId))),
      create: vi.fn(async ({ data }: Row) => {
        if (state.compositions.some((row) =>
          row.ownerId === data.ownerId
          && row.creationIdempotencyKey === data.creationIdempotencyKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        const row = {
          archivedAt: null,
          createdAt: new Date('2026-07-26T00:00:00.000Z'),
          updatedAt: new Date('2026-07-26T00:00:00.000Z'),
          ...data,
        }
        state.compositions.push(row)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const row = state.compositions.find((candidate) =>
          candidate.id === where.id
          && candidate.currentVersion === where.currentVersion
          && candidate.concurrencyToken === where.concurrencyToken
          && candidate.readOnly === where.readOnly
          && candidate.archivedAt === where.archivedAt)
        if (!row) return { count: 0 }
        Object.assign(row, data, { updatedAt: new Date('2026-07-26T00:01:00.000Z') })
        return { count: 1 }
      }),
    },
    creativeCompositionVersion: {
      findUnique: vi.fn(async ({ where }: Row) => {
        if (where.id) return state.versions.find((row) => row.id === where.id) ?? null
        const key = where.compositionId_version
        return state.versions.find((row) =>
          row.compositionId === key?.compositionId
          && row.version === key?.version) ?? null
      }),
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          id: `version-${data.compositionId}-${data.version}`,
          createdAt: new Date('2026-07-26T00:00:30.000Z'),
          ...data,
        }
        state.versions.push(row)
        return row
      }),
    },
    creativeCompositionNode: {
      createMany: vi.fn(async ({ data }: Row) => {
        state.nodes.push(...data)
        return { count: data.length }
      }),
    },
    creativeOperationBatch: {
      findUnique: vi.fn(async ({ where }: Row) => {
        if (where.id) return state.batches.find((row) => row.id === where.id) ?? null
        const key = where.compositionId_idempotencyKey
        return state.batches.find((row) =>
          row.compositionId === key?.compositionId
          && row.idempotencyKey === key?.idempotencyKey) ?? null
      }),
      findMany: vi.fn(async ({ where }: Row) => state.batches
        .filter((row) => row.compositionId === where.compositionId)
        .filter((row) => row.resultVersion <= where.resultVersion.lte)
        .filter((row) => !where.kind?.in || where.kind.in.includes(row.kind))
        .sort((left, right) =>
          left.resultVersion - right.resultVersion
          || String(left.id).localeCompare(String(right.id)))),
      findFirst: vi.fn(async ({ where }: Row) => state.batches.find((row) =>
        row.compositionId === where.compositionId
        && row.resultVersion === where.resultVersion
        && (!where.id || row.id === where.id)
        && matchesKind(row.kind, where.kind)) ?? null),
      create: vi.fn(async ({ data }: Row) => {
        if (state.batches.some((row) =>
          row.compositionId === data.compositionId
          && row.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        const row = {
          targetBatchId: null,
          targetVersion: null,
          createdAt: new Date('2026-07-26T00:00:20.000Z'),
          ...data,
        }
        state.batches.push(row)
        return row
      }),
    },
    creativeEditOperation: {
      findMany: vi.fn(async ({ where }: Row) => state.operations
        .filter((row) => row.batchId === where.batchId)
        .sort((left, right) => left.sequence - right.sequence)),
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          auditedAt: new Date('2026-07-26T00:00:25.000Z'),
          ...data,
        }
        state.operations.push(row)
        return row
      }),
    },
    creativeRollbackPoint: {
      findUnique: vi.fn(async ({ where }: Row) => {
        if (where.sourceBatchId) {
          return state.rollbackPoints.find((row) =>
            row.sourceBatchId === where.sourceBatchId) ?? null
        }
        return state.rollbackPoints.find((row) => row.id === where.id) ?? null
      }),
      findFirst: vi.fn(async ({ where }: Row) => state.rollbackPoints.find((row) =>
        row.id === where.id && row.compositionId === where.compositionId) ?? null),
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          createdAt: new Date('2026-07-26T00:00:40.000Z'),
          ...data,
        }
        state.rollbackPoints.push(row)
        return row
      }),
    },
    $transaction: vi.fn(async (callback: (client: Row) => Promise<unknown>) => {
      state.transactionCalls += 1
      return callback(prisma)
    }),
  }

  return {
    prisma,
    state,
    reset(seed: {
      document: Row
      documentHash: string
      concurrencyToken: string
    }) {
      state.token = {
        sub: 'owner-1',
        name: 'Owner',
        email: 'owner@example.com',
        role: 'SUPER_ADMIN',
      }
      state.project = {
        id: 'project-1',
        ownerId: 'owner-1',
        brandProfileId: 'brand-alma',
        name: 'Launch',
        defaultFolder: 'Approved',
        archivedAt: null,
        productCode: 'ALMA-001',
        productName: 'Panjabi',
        productPriceBdt: 2_500,
        productSourceImage: 'products/alma-001.png',
        currentRecipe: null,
        assets: [{
          id: 'asset-1',
          assetType: 'image',
          title: 'Hero',
          updatedAt: new Date('2026-07-26T00:00:00.000Z'),
          versions: [{
            id: 'asset-version-1',
            version: 1,
            metadata: {},
            createdAt: new Date('2026-07-26T00:00:00.000Z'),
          }],
        }],
      }
      state.compositions.splice(0, state.compositions.length, {
        id: 'composition-1',
        ownerId: 'owner-1',
        brandProfileId: 'brand-alma',
        projectId: 'project-1',
        title: 'Launch composition',
        sourceKind: 'PROJECT_PROJECTION',
        schemaVersion: 1,
        currentVersion: 1,
        concurrencyToken: seed.concurrencyToken,
        readOnly: false,
        creationIdempotencyKey: 'seed-composition-key',
        creationRequestFingerprint: 'seed-fingerprint',
        createdById: 'owner-1',
        createdAt: new Date('2026-07-26T00:00:00.000Z'),
        updatedAt: new Date('2026-07-26T00:00:00.000Z'),
        archivedAt: null,
      })
      state.versions.splice(0, state.versions.length, {
        id: 'version-composition-1-1',
        compositionId: 'composition-1',
        version: 1,
        schemaVersion: 1,
        parentVersion: null,
        document: seed.document,
        documentHash: seed.documentHash,
        operationBatchId: 'seed-create-batch',
        createdById: 'owner-1',
        createdAt: new Date('2026-07-26T00:00:00.000Z'),
      })
      state.batches.splice(0)
      state.operations.splice(0)
      state.rollbackPoints.splice(0)
      state.nodes.splice(0)
      state.transactionCalls = 0
      for (const model of Object.values(prisma)) {
        if (!model || typeof model !== 'object') continue
        for (const method of Object.values(model)) {
          if (typeof method === 'function' && 'mockClear' in method) {
            ;(method as { mockClear: () => void }).mockClear()
          }
        }
      }
    },
    useActor(
      userId: 'owner-1' | 'creator-1' | 'reviewer-1',
      role: 'SUPER_ADMIN' | 'STAFF' = userId === 'owner-1' ? 'SUPER_ADMIN' : 'STAFF',
    ) {
      state.token = {
        sub: userId,
        name: userId,
        email: `${userId}@example.com`,
        role,
      }
    },
  }
})

vi.mock('@/lib/prisma', () => ({ prisma: compositionHarness.prisma }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/agent-runtime-flag', () => ({ isAgentEnabled: () => true }))
vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => compositionHarness.state.token),
}))

import {
  CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV,
  CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV,
} from '@/lib/creative-studio/composition-feature-flags'
import { CREATIVE_COMPOSITION_API_REQUEST_MAX_BYTES } from '@/lib/creative-studio/composition-route'
import { projectToReadonlyComposition } from '@/lib/creative-studio/composition-projection'
import { GET as listCompositions, POST as createComposition } from '@/app/api/assistant/creative-studio/compositions/route'
import { GET as getComposition } from '@/app/api/assistant/creative-studio/compositions/[id]/route'
import { POST as planOperations } from '@/app/api/assistant/creative-studio/compositions/[id]/plan/route'
import { POST as validateOperations } from '@/app/api/assistant/creative-studio/compositions/[id]/operations/validate/route'
import { POST as applyOperations } from '@/app/api/assistant/creative-studio/compositions/[id]/operations/apply/route'
import { POST as undoOperations } from '@/app/api/assistant/creative-studio/compositions/[id]/undo/route'
import { POST as redoOperations } from '@/app/api/assistant/creative-studio/compositions/[id]/redo/route'
import { POST as rollbackComposition } from '@/app/api/assistant/creative-studio/compositions/[id]/rollback/route'

const originalMode = process.env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV]
const originalWrites = process.env[CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV]

function seedProjection() {
  return projectToReadonlyComposition({
    compositionId: 'composition-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    brandProfileId: 'brand-alma',
    name: 'Launch',
    defaultFolder: 'Approved',
    product: {
      code: 'ALMA-001',
      name: 'Panjabi',
      priceBdt: 2_500,
      sourceImage: 'products/alma-001.png',
    },
    recipe: null,
    assets: [{
      id: 'asset-1',
      assetType: 'image',
      title: 'Hero',
      versionId: 'asset-version-1',
      version: 1,
    }],
    readonly: false,
  })
}

function request(url: string, body?: Record<string, unknown>) {
  return new NextRequest(`http://local${url}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
}

function operation(name: string) {
  const document = compositionHarness.state.versions[0].document
  const node = document.nodes[0]
  return {
    type: 'node.replace',
    nodeId: node.id,
    node: { ...node, name },
  }
}

function applyBody(
  idempotencyKey: string,
  name = 'Updated hero',
  version = 1,
  token = compositionHarness.state.compositions[0].concurrencyToken,
) {
  return {
    expectedVersion: version,
    expectedConcurrencyToken: token,
    idempotencyKey,
    brandProfileId: 'brand-alma',
    operations: [operation(name)],
  }
}

beforeEach(() => {
  const seed = seedProjection()
  compositionHarness.reset(seed)
  process.env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV] = 'enforce'
  process.env[CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV] = 'true'
})

afterAll(() => {
  if (originalMode === undefined) delete process.env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV]
  else process.env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV] = originalMode
  if (originalWrites === undefined) {
    delete process.env[CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV]
  } else {
    process.env[CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV] = originalWrites
  }
})

describe('Creative composition direct API security and commands', () => {
  it('authenticates every command route before feature/service execution', async () => {
    compositionHarness.state.token = null
    const commandBody = {
      expectedVersion: 1,
      expectedConcurrencyToken: seedProjection().concurrencyToken,
      idempotencyKey: 'auth-required-001',
      operations: [operation('Blocked')],
    }
    const historyBody = {
      expectedVersion: 1,
      expectedConcurrencyToken: seedProjection().concurrencyToken,
      idempotencyKey: 'auth-history-001',
    }
    const params = { params: Promise.resolve({ id: 'composition-1' }) }
    const responses = await Promise.all([
      listCompositions(request('/api/assistant/creative-studio/compositions')),
      createComposition(request('/api/assistant/creative-studio/compositions', {
        projectId: 'project-1',
        idempotencyKey: 'auth-create-001',
      })),
      getComposition(
        request('/api/assistant/creative-studio/compositions/composition-1'),
        params,
      ),
      planOperations(
        request('/api/assistant/creative-studio/compositions/composition-1/plan', commandBody),
        params,
      ),
      validateOperations(
        request(
          '/api/assistant/creative-studio/compositions/composition-1/operations/validate',
          commandBody,
        ),
        params,
      ),
      applyOperations(
        request(
          '/api/assistant/creative-studio/compositions/composition-1/operations/apply',
          commandBody,
        ),
        params,
      ),
      undoOperations(
        request('/api/assistant/creative-studio/compositions/composition-1/undo', historyBody),
        params,
      ),
      redoOperations(
        request('/api/assistant/creative-studio/compositions/composition-1/redo', historyBody),
        params,
      ),
      rollbackComposition(
        request('/api/assistant/creative-studio/compositions/composition-1/rollback', {
          ...historyBody,
          rollbackPointId: 'rollback-point-1',
        }),
        params,
      ),
    ])

    expect(responses.map((response) => response.status)).toEqual(Array(9).fill(401))
    expect(compositionHarness.state.batches).toHaveLength(0)
  })

  it('keeps legacy as the explicit fallback while the foundation flag is off', async () => {
    process.env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV] = 'off'
    const response = await listCompositions(request(
      '/api/assistant/creative-studio/compositions?projectId=project-1',
    ))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: 'creative_studio_v3_foundation_disabled',
      legacyDefault: true,
      legacyFallback: true,
    })
  })

  it('fails closed when a projected legacy project has no brand', async () => {
    compositionHarness.state.project.brandProfileId = null
    const response = await listCompositions(request(
      '/api/assistant/creative-studio/compositions?projectId=project-1&projection=readonly',
    ))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'project_brand_missing',
      details: { projectId: 'project-1' },
    })
    expect(compositionHarness.prisma.creativeBrandProfile.findUnique).not.toHaveBeenCalled()
  })

  it('allows Reviewer read-only projection but rejects Reviewer plan and apply', async () => {
    compositionHarness.useActor('reviewer-1')
    process.env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV] = 'shadow'
    process.env[CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV] = 'false'
    const projection = await listCompositions(request(
      '/api/assistant/creative-studio/compositions?projectId=project-1&projection=readonly',
    ))
    expect(projection.status).toBe(200)
    await expect(projection.json()).resolves.toMatchObject({
      projection: { readonly: true, persisted: false, accessRole: 'reviewer' },
    })

    const plan = await planOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/plan', {
        ...applyBody('reviewer-plan-001'),
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(plan.status).toBe(403)
    await expect(plan.json()).resolves.toMatchObject({ error: 'studio_draft_forbidden' })

    process.env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV] = 'enforce'
    process.env[CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV] = 'true'
    const apply = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply', {
        ...applyBody('reviewer-apply-001'),
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(apply.status).toBe(403)
    expect(compositionHarness.state.batches).toHaveLength(0)
  })

  it('plans and validates the same canonical batch without writing', async () => {
    compositionHarness.useActor('creator-1')
    process.env[CREATIVE_STUDIO_V3_FOUNDATION_MODE_ENV] = 'shadow'
    process.env[CREATIVE_STUDIO_V3_COMPOSITION_WRITES_ENV] = 'false'
    const body = applyBody('plan-validate-001')
    const params = { params: Promise.resolve({ id: 'composition-1' }) }
    const plannedResponse = await planOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/plan', body),
      params,
    )
    const validatedResponse = await validateOperations(
      request(
        '/api/assistant/creative-studio/compositions/composition-1/operations/validate',
        body,
      ),
      params,
    )

    expect(plannedResponse.status).toBe(200)
    expect(validatedResponse.status).toBe(200)
    const planned = await plannedResponse.json()
    const validated = await validatedResponse.json()
    expect(validated.validation).toMatchObject({
      valid: true,
      batchId: planned.plan.batchId,
      requestFingerprint: planned.plan.requestFingerprint,
      documentHash: planned.plan.documentHash,
      resultConcurrencyToken: planned.plan.resultConcurrencyToken,
    })
    expect(compositionHarness.state.transactionCalls).toBe(0)
    expect(compositionHarness.state.batches).toHaveLength(0)
    expect(compositionHarness.state.versions).toHaveLength(1)
  })

  it('rejects cross-brand and caller-supplied authority/fingerprint fields', async () => {
    compositionHarness.useActor('creator-1')
    const crossBrand = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply', {
        ...applyBody('cross-brand-001'),
        brandProfileId: 'brand-trading',
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(crossBrand.status).toBe(403)
    await expect(crossBrand.json()).resolves.toMatchObject({ error: 'brand_scope_mismatch' })

    const forged = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply', {
        ...applyBody('forged-authority-001'),
        actorRole: 'OWNER',
        requestFingerprint: 'forged',
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(forged.status).toBe(422)
    await expect(forged.json()).resolves.toMatchObject({
      error: 'invalid_composition_request',
    })
    expect(compositionHarness.state.batches).toHaveLength(0)
  })

  it('rejects oversized API bodies before JSON validation or service execution', async () => {
    compositionHarness.useActor('creator-1')
    const response = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply', {
        padding: 'x'.repeat(CREATIVE_COMPOSITION_API_REQUEST_MAX_BYTES),
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: 'creative_composition_request_too_large',
      details: { maxBytes: CREATIVE_COMPOSITION_API_REQUEST_MAX_BYTES },
    })
    expect(compositionHarness.state.batches).toHaveLength(0)
    expect(compositionHarness.state.transactionCalls).toBe(0)
  })

  it('rejects stale versions with the current server token and no audit append', async () => {
    compositionHarness.useActor('creator-1')
    const response = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply', {
        ...applyBody('stale-version-001', 'Stale', 2),
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'composition_conflict',
      details: {
        currentVersion: 1,
        currentConcurrencyToken: compositionHarness.state.compositions[0].concurrencyToken,
      },
    })
    expect(compositionHarness.state.batches).toHaveLength(0)
    expect(compositionHarness.state.operations).toHaveLength(0)
    expect(compositionHarness.state.versions).toHaveLength(1)
  })

  it('rejects future undo versions as optimistic conflicts before history resolution', async () => {
    compositionHarness.useActor('creator-1')
    const response = await undoOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/undo', {
        expectedVersion: 2,
        expectedConcurrencyToken: compositionHarness.state.compositions[0].concurrencyToken,
        idempotencyKey: 'future-undo-001',
        brandProfileId: 'brand-alma',
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'composition_conflict',
      details: { currentVersion: 1 },
    })
    expect(compositionHarness.state.batches).toHaveLength(0)
    expect(compositionHarness.state.transactionCalls).toBe(0)
  })

  it('appends version, operation, rollback, and audit atomically and enforces idempotency', async () => {
    compositionHarness.useActor('creator-1')
    const body = applyBody('idempotent-apply-001')
    const first = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply', body),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(first.status).toBe(201)
    const firstReceipt = await first.json()

    expect(compositionHarness.state.transactionCalls).toBe(1)
    expect(compositionHarness.state.compositions[0].currentVersion).toBe(2)
    expect(compositionHarness.state.batches).toHaveLength(1)
    expect(compositionHarness.state.operations).toHaveLength(1)
    expect(compositionHarness.state.versions).toHaveLength(2)
    expect(compositionHarness.state.rollbackPoints).toHaveLength(1)
    expect(compositionHarness.state.operations[0]).toMatchObject({
      actorId: 'creator-1',
      actorRole: 'CREATOR',
      effectClass: 'ZERO_COST_LOCAL',
      estimatedCostBdt: 0,
    })
    expect(firstReceipt).toMatchObject({
      idempotent: false,
      batch: { resultVersion: 2, operationCount: 1 },
      version: { version: 2 },
    })

    const replay = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply', body),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(replay.status).toBe(200)
    const replayReceipt = await replay.json()
    expect(replayReceipt.idempotent).toBe(true)
    const { idempotent: _firstIdempotent, ...firstCanonicalReceipt } = firstReceipt
    const { idempotent: _replayIdempotent, ...replayCanonicalReceipt } = replayReceipt
    expect(replayCanonicalReceipt).toEqual(firstCanonicalReceipt)
    expect(compositionHarness.state.transactionCalls).toBe(1)
    expect(compositionHarness.state.batches).toHaveLength(1)

    const changed = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply', {
        ...body,
        operations: [operation('Changed request')],
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(changed.status).toBe(409)
    await expect(changed.json()).resolves.toMatchObject({ error: 'idempotency_conflict' })
    expect(compositionHarness.state.batches).toHaveLength(1)
  })

  it('undoes, redoes, and rolls back by appending new versions', async () => {
    compositionHarness.useActor('creator-1')
    const originalName = compositionHarness.state.versions[0].document.nodes[0].name
    const appliedResponse = await applyOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/operations/apply',
        applyBody('history-apply-001', 'Changed hero')),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    const applied = await appliedResponse.json()

    const undoneResponse = await undoOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/undo', {
        expectedVersion: applied.version.version,
        expectedConcurrencyToken: applied.version.concurrencyToken,
        idempotencyKey: 'history-undo-001',
        brandProfileId: 'brand-alma',
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(undoneResponse.status).toBe(201)
    const undone = await undoneResponse.json()
    expect(undone.version.document.nodes[0].name).toBe(originalName)
    expect(undone.batch).toMatchObject({
      kind: 'UNDO',
      targetBatchId: applied.batch.id,
    })

    const redoResponse = await redoOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/redo', {
        expectedVersion: undone.version.version,
        expectedConcurrencyToken: undone.version.concurrencyToken,
        idempotencyKey: 'history-redo-001',
        brandProfileId: 'brand-alma',
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(redoResponse.status).toBe(201)
    const redone = await redoResponse.json()
    expect(redone.version.document.nodes[0].name).toBe('Changed hero')

    const rollbackResponse = await rollbackComposition(
      request('/api/assistant/creative-studio/compositions/composition-1/rollback', {
        expectedVersion: redone.version.version,
        expectedConcurrencyToken: redone.version.concurrencyToken,
        idempotencyKey: 'history-rollback-001',
        brandProfileId: 'brand-alma',
        rollbackPointId: applied.rollbackPointId,
      }),
      { params: Promise.resolve({ id: 'composition-1' }) },
    )
    expect(rollbackResponse.status).toBe(201)
    const rolledBack = await rollbackResponse.json()
    expect(rolledBack.version.version).toBe(5)
    expect(rolledBack.version.document.nodes[0].name).toBe(originalName)
    expect(rolledBack.batch).toMatchObject({ kind: 'ROLLBACK', targetVersion: 1 })
    expect(compositionHarness.state.versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5])
  })

  it('supports durable multi-level undo/redo and clears redo after a new edit', async () => {
    compositionHarness.useActor('creator-1')
    const params = { params: Promise.resolve({ id: 'composition-1' }) }
    const originalName = compositionHarness.state.versions[0].document.nodes[0].name
    const runApply = async (key: string, name: string) => {
      const current = compositionHarness.state.compositions[0]
      const response = await applyOperations(
        request(
          '/api/assistant/creative-studio/compositions/composition-1/operations/apply',
          applyBody(key, name, current.currentVersion, current.concurrencyToken),
        ),
        params,
      )
      expect(response.status).toBe(201)
      return response.json()
    }
    const runHistory = async (
      route: typeof undoOperations,
      endpoint: 'undo' | 'redo',
      key: string,
    ) => {
      const current = compositionHarness.state.compositions[0]
      const response = await route(
        request(`/api/assistant/creative-studio/compositions/composition-1/${endpoint}`, {
          expectedVersion: current.currentVersion,
          expectedConcurrencyToken: current.concurrencyToken,
          idempotencyKey: key,
          brandProfileId: 'brand-alma',
        }),
        params,
      )
      expect(response.status).toBe(201)
      return response.json()
    }

    const appliedA = await runApply('stack-apply-a-001', 'Edit A')
    const appliedB = await runApply('stack-apply-b-001', 'Edit B')
    const undoneB = await runHistory(undoOperations, 'undo', 'stack-undo-b-001')
    expect(undoneB.version.document.nodes[0].name).toBe('Edit A')
    expect(undoneB.batch.targetBatchId).toBe(appliedB.batch.id)

    const undoneA = await runHistory(undoOperations, 'undo', 'stack-undo-a-001')
    expect(undoneA.version.document.nodes[0].name).toBe(originalName)
    expect(undoneA.batch.targetBatchId).toBe(appliedA.batch.id)

    const redoneA = await runHistory(redoOperations, 'redo', 'stack-redo-a-001')
    expect(redoneA.version.document.nodes[0].name).toBe('Edit A')
    expect(redoneA.batch.targetBatchId).toBe(appliedA.batch.id)

    const redoneB = await runHistory(redoOperations, 'redo', 'stack-redo-b-001')
    expect(redoneB.version.document.nodes[0].name).toBe('Edit B')
    expect(redoneB.batch.targetBatchId).toBe(appliedB.batch.id)
    expect(compositionHarness.state.versions.map((row) => row.version))
      .toEqual([1, 2, 3, 4, 5, 6, 7])

    await runHistory(undoOperations, 'undo', 'stack-undo-b-again-001')
    await runApply('stack-new-edit-001', 'Edit C')
    const current = compositionHarness.state.compositions[0]
    const invalidatedRedo = await redoOperations(
      request('/api/assistant/creative-studio/compositions/composition-1/redo', {
        expectedVersion: current.currentVersion,
        expectedConcurrencyToken: current.concurrencyToken,
        idempotencyKey: 'stack-redo-invalidated-001',
        brandProfileId: 'brand-alma',
      }),
      params,
    )
    expect(invalidatedRedo.status).toBe(409)
    await expect(invalidatedRedo.json()).resolves.toMatchObject({
      error: 'redo_target_not_found',
    })
    expect(compositionHarness.state.compositions[0].currentVersion).toBe(9)
    expect(compositionHarness.state.versions).toHaveLength(9)
  })

  it('creates a writable composition from a read-only project projection idempotently', async () => {
    compositionHarness.useActor('creator-1')
    const body = {
      projectId: 'project-1',
      brandProfileId: 'brand-alma',
      title: 'Creator composition',
      idempotencyKey: 'create-composition-001',
    }
    const first = await createComposition(
      request('/api/assistant/creative-studio/compositions', body),
    )
    expect(first.status).toBe(201)
    const firstReceipt = await first.json()
    expect(firstReceipt).toMatchObject({
      idempotent: false,
      composition: {
        projectId: 'project-1',
        brandProfileId: 'brand-alma',
        readonly: false,
        accessRole: 'creator',
        document: { readonly: false },
      },
    })

    const replay = await createComposition(
      request('/api/assistant/creative-studio/compositions', body),
    )
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      idempotent: true,
      composition: { id: firstReceipt.composition.id },
    })

    const changed = await createComposition(
      request('/api/assistant/creative-studio/compositions', {
        ...body,
        title: 'Changed title',
      }),
    )
    expect(changed.status).toBe(409)
    await expect(changed.json()).resolves.toMatchObject({ error: 'idempotency_conflict' })
  })
})
