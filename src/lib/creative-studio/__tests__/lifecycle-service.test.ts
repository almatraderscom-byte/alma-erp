import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycleHarness = vi.hoisted(() => {
  // Prisma mock rows deliberately model heterogeneous JSON/BigInt records.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Row = Record<string, any>
  const state = {
    currentVersion: 2,
    actualLatestVersionId: 'asset-version-2',
    actualReviewEventId: 'review-2',
    actualApprovedArtifactVersionId: 'asset-version-2',
    actualReviewCompositionVersionId: 'composition-version-2',
    reviewState: 'APPROVED',
    nodePresent: true,
    batchResultVersion: 2,
    flagsEnabled: true,
    actorActive: true,
    actorRole: 'SUPER_ADMIN',
    brandOwnerId: 'owner-1',
    projectOwnerId: 'owner-1',
    assignmentRole: 'CREATOR',
    jobs: new Map<string, Row>(),
    audits: [] as Row[],
    receipts: [] as Row[],
    outputAssets: [] as Row[],
    outputVersions: [] as Row[],
    outputLineage: [] as Row[],
    flagRows: [] as Row[],
    flagAudits: [] as Row[],
    nextJob: 1,
    transactionTail: Promise.resolve() as Promise<unknown>,
  }
  const composition = () => ({
    id: 'composition-1',
    ownerId: 'owner-1',
    brandProfileId: 'brand-1',
    projectId: 'project-1',
    currentVersion: state.currentVersion,
    archivedAt: null,
  })
  const version = {
    id: 'composition-version-2',
    compositionId: 'composition-1',
    version: 2,
    documentHash: 'a'.repeat(64),
    operationBatchId: 'batch-2',
    document: { schemaVersion: 1, compositionId: 'composition-1' },
  }
  const artifactVersion = {
    id: 'asset-version-2',
    assetId: 'asset-1',
    version: 2,
    storagePath: 'generated/source.png',
    metadata: { checksumSha256: 'b'.repeat(64), byteSize: 2048 },
    asset: {
      id: 'asset-1',
      projectId: 'project-1',
      project: {
        id: 'project-1',
        brandProfileId: 'brand-1',
      },
      reviewEvents: [{
        id: 'review-2',
        approvedArtifactVersionId: 'asset-version-2',
        metadata: { approvedVersionId: 'asset-version-2' },
      }],
    },
  }
  const reviewEvent = {
    id: 'review-2',
    assetId: 'asset-1',
    toState: 'APPROVED',
    compositionId: 'composition-1',
    compositionVersionId: 'composition-version-2',
    compositionVersion: 2,
    compositionDocumentHash: 'a'.repeat(64),
    approvedArtifactVersionId: 'asset-version-2',
    metadata: { approvedVersionId: 'asset-version-2' },
  }
  function matchJob(where: Row): Row | null {
    if (where.id) return state.jobs.get(String(where.id)) ?? null
    if (where.ownerId_idempotencyKey) {
      const key = where.ownerId_idempotencyKey
      return [...state.jobs.values()].find((row) => (
        row.ownerId === key.ownerId && row.idempotencyKey === key.idempotencyKey
      )) ?? null
    }
    if (where.ownerId_renderFingerprint) {
      const key = where.ownerId_renderFingerprint
      return [...state.jobs.values()].find((row) => (
        row.ownerId === key.ownerId && row.renderFingerprint === key.renderFingerprint
      )) ?? null
    }
    return null
  }
  const prisma: Row = {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'owner-1',
        role: state.actorRole,
        active: state.actorActive,
      })),
    },
    creativeBrandProfile: {
      findUnique: vi.fn(async () => ({
        id: 'brand-1',
        ownerId: state.brandOwnerId,
      })),
    },
    creativeStudioRoleAssignment: {
      findUnique: vi.fn(async () => ({
        ownerId: 'owner-1',
        role: state.assignmentRole,
      })),
    },
    creativeComposition: {
      findUnique: vi.fn(async () => composition()),
    },
    creativeCompositionVersion: {
      findUnique: vi.fn(async () => version),
    },
    creativeAssetVersion: {
      findUnique: vi.fn(async () => artifactVersion),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `output-version-${state.outputVersions.length + 1}`, ...data }
        state.outputVersions.push(row)
        return row
      }),
    },
    creativeProjectAsset: {
      findUnique: vi.fn(async () => ({
        id: 'asset-1',
        projectId: 'project-1',
        reviewState: state.reviewState,
        reviewSequence: 2,
        versions: [{
          ...artifactVersion,
          id: state.actualLatestVersionId,
        }],
        reviewEvents: state.actualReviewEventId ? [{
          ...reviewEvent,
          id: state.actualReviewEventId,
          approvedArtifactVersionId: state.actualApprovedArtifactVersionId,
          compositionVersionId: state.actualReviewCompositionVersionId,
        }] : [],
      })),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `output-asset-${state.outputAssets.length + 1}`, ...data }
        state.outputAssets.push(row)
        return row
      }),
    },
    creativeAssetLineage: {
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `output-lineage-${state.outputLineage.length + 1}`, ...data }
        state.outputLineage.push(row)
        return row
      }),
    },
    creativeCompositionNode: {
      findFirst: vi.fn(async () => state.nodePresent ? { id: 'node-1' } : null),
      findMany: vi.fn(async () => state.nodePresent
        ? [{ assetVersionId: 'asset-version-2' }]
        : []),
    },
    creativeAssetReviewEvent: {
      findUnique: vi.fn(async () => reviewEvent),
    },
    creativeOperationBatch: {
      findUnique: vi.fn(async () => ({
        id: 'batch-2',
        compositionId: 'composition-1',
        resultVersion: state.batchResultVersion,
      })),
    },
    creativeProject: {
      findUnique: vi.fn(async () => ({
        id: 'project-1',
        ownerId: state.projectOwnerId,
        brandProfileId: 'brand-1',
      })),
    },
    creativeLifecycleFeatureFlag: {
      findMany: vi.fn(async ({ where }: Row) => {
        if (where.role) {
          return state.flagRows.filter((row) => (
            row.ownerId === where.ownerId
            && row.brandProfileId === where.brandProfileId
            && row.projectId === where.projectId
            && row.role === where.role
            && row.capability === where.capability
          ))
        }
        return state.flagsEnabled ? [{
          id: `flag-${where.capability}`,
          ownerId: 'owner-1',
          brandProfileId: 'brand-1',
          projectId: 'project-1',
          role: 'OWNER',
          capability: where.capability,
          enabled: true,
          dualReadEnabled: false,
          legacyFallbackEnabled: true,
          canaryPercent: 100,
        }] : []
      }),
      findFirst: vi.fn(async ({ where }: Row) => state.flagRows.find((row) => (
        row.ownerId === where.ownerId
        && row.brandProfileId === where.brandProfileId
        && row.projectId === where.projectId
        && row.role === where.role
        && row.capability === where.capability
      )) ?? null),
      findUnique: vi.fn(async ({ where }: Row) => (
        state.flagRows.find((row) => row.id === where.id) ?? null
      )),
      create: vi.fn(async ({ data }: Row) => {
        const now = new Date('2026-07-26T00:00:00.000Z')
        const row = { id: `flag-row-${state.flagRows.length + 1}`, createdAt: now, updatedAt: now, ...data }
        state.flagRows.push(row)
        return row
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = state.flagRows.find((entry) => entry.id === where.id)
        if (!row) throw new Error('flag missing')
        Object.assign(row, data, { updatedAt: new Date('2026-07-26T00:01:00.000Z') })
        return row
      }),
    },
    creativeLifecycleFlagAuditEvent: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const key = where.ownerId_idempotencyKey
        return state.flagAudits.find((row) => (
          row.ownerId === key.ownerId && row.idempotencyKey === key.idempotencyKey
        )) ?? null
      }),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `flag-audit-${state.flagAudits.length + 1}`, ...data }
        state.flagAudits.push(row)
        return row
      }),
    },
    creativeLifecycleJob: {
      findUnique: vi.fn(async ({ where }: Row) => matchJob(where)),
      findMany: vi.fn(async ({ where }: Row) => [...state.jobs.values()].filter((row) => (
        (!where.status || row.status === where.status)
        && (!where.effectClass || row.effectClass === where.effectClass)
        && (where.paidExecutionAllowed == null
          || row.paidExecutionAllowed === where.paidExecutionAllowed)
      ))),
      create: vi.fn(async ({ data }: Row) => {
        const now = new Date('2026-07-26T00:00:00.000Z')
        const row = {
          id: `job-${state.nextJob++}`,
          progressCompleted: 0,
          progressTotal: 4,
          attempts: 0,
          resultStoragePath: null,
          resultChecksum: null,
          resultBytes: null,
          verifiedAt: null,
          lastErrorCode: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        }
        state.jobs.set(row.id, row)
        return row
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const row = matchJob(where)
        if (!row) return { count: 0 }
        if (where.status && row.status !== where.status) return { count: 0 }
        if (where.leaseToken && row.leaseToken !== where.leaseToken) return { count: 0 }
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            row[key] = Number(row[key] ?? 0) + Number(value.increment)
          } else {
            row[key] = value
          }
        }
        row.updatedAt = new Date('2026-07-26T00:01:00.000Z')
        return { count: 1 }
      }),
    },
    creativeLifecycleAuditEvent: {
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `audit-${state.audits.length + 1}`, ...data }
        state.audits.push(row)
        return row
      }),
      findUnique: vi.fn(async ({ where }: Row) => {
        const key = where.jobId_idempotencyKey
        return state.audits.find((row) => (
          row.jobId === key.jobId && row.idempotencyKey === key.idempotencyKey
        )) ?? null
      }),
    },
    creativeLifecycleReceipt: {
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `receipt-${state.receipts.length + 1}`, ...data }
        state.receipts.push(row)
        return row
      }),
      findFirst: vi.fn(async ({ where }: Row) => state.receipts.find((row) => (
        row.jobId === where.jobId && row.status === where.status
      )) ?? null),
    },
  }
  prisma.$transaction = vi.fn((callback: (tx: Row) => Promise<unknown>) => {
    const run = state.transactionTail.then(() => callback(prisma))
    state.transactionTail = run.catch(() => undefined)
    return run
  })
  return {
    prisma,
    state,
    version,
    artifactVersion,
    reset() {
      state.currentVersion = 2
      state.actualLatestVersionId = 'asset-version-2'
      state.actualReviewEventId = 'review-2'
      state.actualApprovedArtifactVersionId = 'asset-version-2'
      state.actualReviewCompositionVersionId = 'composition-version-2'
      state.reviewState = 'APPROVED'
      state.nodePresent = true
      state.batchResultVersion = 2
      state.flagsEnabled = true
      state.actorActive = true
      state.actorRole = 'SUPER_ADMIN'
      state.brandOwnerId = 'owner-1'
      state.projectOwnerId = 'owner-1'
      state.assignmentRole = 'CREATOR'
      state.jobs.clear()
      state.audits.splice(0)
      state.receipts.splice(0)
      state.outputAssets.splice(0)
      state.outputVersions.splice(0)
      state.outputLineage.splice(0)
      state.flagRows.splice(0)
      state.flagAudits.splice(0)
      state.nextJob = 1
      state.transactionTail = Promise.resolve()
      vi.clearAllMocks()
      process.env.AGENT_ENABLED = 'true'
      delete process.env.CREATIVE_STUDIO_V3_PAID_RENDER_ENABLED
    },
    insertRunning(id: string) {
      const now = new Date('2026-07-26T00:00:00.000Z')
      state.jobs.set(id, {
        id,
        ownerId: 'owner-1',
        brandProfileId: 'brand-1',
        projectId: 'project-1',
        compositionId: 'composition-1',
        compositionVersionId: 'composition-version-2',
        compositionVersion: 2,
        compositionDocumentHash: 'a'.repeat(64),
        operationBatchId: 'batch-2',
        sourceArtifactVersionId: 'asset-version-2',
        sourceStoragePath: 'generated/source.png',
        sourceChecksum: 'b'.repeat(64),
        sourceBytes: BigInt(2048),
        approvedReviewEventId: 'review-2',
        approvedArtifactVersionId: 'asset-version-2',
        reviewFingerprint: 'c'.repeat(64),
        kind: 'RENDER',
        renderProfile: 'composition-manifest-v1',
        outputFormat: 'json',
        rendererVersion: 'composition-manifest-v1',
        renderFingerprint: 'd'.repeat(64),
        idempotencyKey: `result-${id}`,
        requestFingerprint: 'e'.repeat(64),
        effectClass: 'ZERO_COST_LOCAL',
        estimatedCostBdt: 0,
        paidExecutionAllowed: false,
        status: 'RUNNING',
        progressCompleted: 1,
        progressTotal: 4,
        attempts: 1,
        leaseToken: `lease-${id}`,
        leaseExpiresAt: new Date('2026-07-26T00:15:00.000Z'),
        resultStoragePath: null,
        resultChecksum: null,
        resultBytes: null,
        resultArtifactVersionId: null,
        verifiedAt: null,
        lastErrorCode: null,
        createdById: 'owner-1',
        createdByRole: 'OWNER',
        createdAt: now,
        updatedAt: now,
      })
    },
  }
})

vi.mock('@/lib/prisma', () => ({ prisma: lifecycleHarness.prisma }))
vi.mock('@/lib/supabase-storage', () => ({
  downloadStorageObject: vi.fn(async () => Buffer.from('unused')),
}))
vi.mock('@/lib/creative-studio/studio-access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/creative-studio/studio-access')>(
    '@/lib/creative-studio/studio-access',
  )
  return {
    ...actual,
    requireStudioBrandAccess: vi.fn(async (actor: { userId: string }, brandProfileId: string) => ({
      brandProfileId,
      ownerId: 'owner-1',
      role: actor.userId === 'reviewer-1'
        ? 'reviewer'
        : actor.userId === 'creator-1' ? 'creator' : 'owner',
      approvalSpendThresholdBdt: 100,
    })),
  }
})

import {
  claimLifecycleJobs,
  configureLifecycleFeatureFlag,
  controlLifecycleJob,
  createLifecycleJob,
  listLifecycleFeatureFlags,
  previewLifecycleJob,
  recordLifecycleWorkerResult,
  resolveLifecycleCompositionPin,
} from '@/lib/creative-studio/lifecycle-service'

const owner = {
  userId: 'owner-1',
  name: 'Owner',
  email: null,
  erpRole: 'SUPER_ADMIN',
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    compositionId: 'composition-1',
    compositionVersionId: 'composition-version-2',
    sourceArtifactVersionId: 'asset-version-2',
    operationBatchId: 'batch-2',
    approvedReviewEventId: 'review-2',
    brandProfileId: 'brand-1',
    projectId: 'project-1',
    kind: 'render',
    renderProfile: 'composition-manifest-v1',
    outputFormat: 'json',
    rendererVersion: 'composition-manifest-v1',
    effectClass: 'zero_cost_local',
    estimatedCostBdt: 0,
    idempotencyKey: 'lifecycle:render:request-1',
    ...overrides,
  }
}

beforeEach(() => lifecycleHarness.reset())

describe('V3 lifecycle production service', () => {
  it('resolves an exact access-scoped Foundation pin without trusting caller scope', async () => {
    await expect(resolveLifecycleCompositionPin(owner, {
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      compositionId: 'composition-1',
      artifactVersionId: 'asset-version-2',
    })).resolves.toMatchObject({
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-2',
      artifactId: 'asset-1',
      artifactVersionId: 'asset-version-2',
      reviewEventId: 'review-2',
      batchId: 'batch-2',
    })

    await expect(resolveLifecycleCompositionPin(owner, {
      brandProfileId: 'brand-1',
      projectId: 'project-other',
      compositionId: 'composition-1',
      artifactVersionId: 'asset-version-2',
    })).rejects.toThrow('project_scope_mismatch')
  })

  it('is default-off and rejects reviewer/brand/project bypasses server-side', async () => {
    lifecycleHarness.state.flagsEnabled = false
    await expect(previewLifecycleJob(owner, request())).rejects.toThrow(
      'lifecycle_capability_disabled',
    )
    lifecycleHarness.state.flagsEnabled = true
    await expect(createLifecycleJob({
      ...owner,
      userId: 'reviewer-1',
      erpRole: 'STAFF',
    }, request())).rejects.toThrow('studio_lifecycle_forbidden')
    await expect(createLifecycleJob(owner, request({
      brandProfileId: 'brand-other',
    }))).rejects.toThrow('brand_scope_mismatch')
    await expect(createLifecycleJob(owner, request({
      projectId: 'project-other',
    }))).rejects.toThrow('project_scope_mismatch')
  })

  it('deduplicates owner+render fingerprint and conflicts on changed key/target/cost', async () => {
    const first = await createLifecycleJob(owner, request())
    const duplicateFingerprint = await createLifecycleJob(owner, request({
      idempotencyKey: 'lifecycle:render:request-2',
    }))
    expect(first.idempotent).toBe(false)
    expect(duplicateFingerprint).toMatchObject({
      idempotent: true,
      job: { id: first.job.id },
    })
    expect(lifecycleHarness.prisma.creativeLifecycleJob.create).toHaveBeenCalledTimes(1)

    await expect(createLifecycleJob(owner, request({
      idempotencyKey: 'lifecycle:render:request-3',
      estimatedCostBdt: 1,
    }))).rejects.toThrow('render_fingerprint_conflict')
    await expect(createLifecycleJob(owner, request({
      renderProfile: 'other-profile',
    }))).rejects.toThrow('idempotency_conflict')
  })

  it('rejects stale composition versions, negative cost, and paid execution by default', async () => {
    lifecycleHarness.state.currentVersion = 3
    await expect(createLifecycleJob(owner, request())).rejects.toThrow(
      'stale_composition_version',
    )
    lifecycleHarness.state.currentVersion = 2
    await expect(createLifecycleJob(owner, request({
      estimatedCostBdt: -1,
    }))).rejects.toThrow('invalid_lifecycle_cost')
    await expect(createLifecycleJob(owner, request({
      effectClass: 'paid',
      confirmedPaidExecution: true,
    }))).rejects.toThrow('paid_lifecycle_execution_disabled')
  })

  it('derives the current approval and latest asset version instead of trusting caller pins', async () => {
    lifecycleHarness.state.actualLatestVersionId = 'asset-version-3'
    await expect(createLifecycleJob(owner, request())).rejects.toThrow(
      'source_artifact_version_stale',
    )
    lifecycleHarness.state.actualLatestVersionId = 'asset-version-2'
    lifecycleHarness.state.actualReviewEventId = 'review-3'
    await expect(createLifecycleJob(owner, request())).rejects.toThrow(
      'review_event_invalidated',
    )
    lifecycleHarness.state.actualReviewEventId = 'review-2'
    lifecycleHarness.state.reviewState = 'CHANGES_REQUESTED'
    await expect(createLifecycleJob(owner, request())).rejects.toThrow(
      'review_not_approved',
    )
    lifecycleHarness.state.reviewState = 'APPROVED'
    lifecycleHarness.state.actualApprovedArtifactVersionId = 'asset-version-1'
    await expect(createLifecycleJob(owner, request())).rejects.toThrow(
      'review_version_invalidated',
    )
    lifecycleHarness.state.actualApprovedArtifactVersionId = 'asset-version-2'
    lifecycleHarness.state.actualReviewCompositionVersionId = 'composition-version-1'
    await expect(createLifecycleJob(owner, request())).rejects.toThrow(
      'review_composition_version_invalidated',
    )
  })

  it('requires the source node and an operation batch that produced the exact version', async () => {
    lifecycleHarness.state.nodePresent = false
    await expect(createLifecycleJob(owner, request())).rejects.toThrow(
      'composition_source_artifact_mismatch',
    )
    lifecycleHarness.state.nodePresent = true
    lifecycleHarness.state.batchResultVersion = 1
    await expect(createLifecycleJob(owner, request())).rejects.toThrow(
      'operation_batch_scope_mismatch',
    )
  })

  it('fails internal services closed under AGENT_ENABLED and keeps worker execution independently off', async () => {
    process.env.AGENT_ENABLED = 'false'
    await expect(claimLifecycleJobs({ workerEnabled: true })).rejects.toThrow('agent_disabled')
    await expect(recordLifecycleWorkerResult({
      jobId: 'missing',
      leaseToken: 'missing',
      outcome: 'failed',
    })).rejects.toThrow('agent_disabled')
    process.env.AGENT_ENABLED = 'true'
    delete process.env.STUDIO_LIFECYCLE_LOCAL_WORKER_ENABLED
    await expect(claimLifecycleJobs()).resolves.toEqual([])
  })

  it('revalidates latest source, node, review and batch before entering RUNNING', async () => {
    const queued = await createLifecycleJob(owner, request())
    lifecycleHarness.state.actualLatestVersionId = 'asset-version-3'
    await expect(claimLifecycleJobs({ workerEnabled: true })).resolves.toEqual([])
    expect(lifecycleHarness.state.jobs.get(queued.job.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      attempts: 0,
      leaseToken: null,
      lastErrorCode: 'source_artifact_version_stale',
    })

    lifecycleHarness.reset()
    const valid = await createLifecycleJob(owner, request())
    const claims = await claimLifecycleJobs({ workerEnabled: true })
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      id: valid.job.id,
      status: 'running',
      sourceStoragePath: 'generated/source.png',
      sourceChecksum: 'b'.repeat(64),
      sourceBytes: 2048,
    })
  })

  it('revalidates current authorization and exact rollout before entering RUNNING', async () => {
    const revokedActor = await createLifecycleJob(owner, request())
    lifecycleHarness.state.actorActive = false
    await expect(claimLifecycleJobs({ workerEnabled: true })).resolves.toEqual([])
    expect(lifecycleHarness.state.jobs.get(revokedActor.job.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      attempts: 0,
      lastErrorCode: 'claim_authorization_revoked',
    })
    expect(lifecycleHarness.state.audits.at(-1)).toMatchObject({
      eventType: 'claim_authorization_quarantined',
      fromStatus: 'QUEUED',
      toStatus: 'NEEDS_REVIEW',
      metadata: {
        authorizationRevoked: true,
        reason: 'claim_authorization_revoked',
      },
    })

    lifecycleHarness.reset()
    const revokedRole = await createLifecycleJob(owner, request())
    lifecycleHarness.state.actorRole = 'STAFF'
    await expect(claimLifecycleJobs({ workerEnabled: true })).resolves.toEqual([])
    expect(lifecycleHarness.state.jobs.get(revokedRole.job.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      lastErrorCode: 'claim_role_revoked',
    })

    lifecycleHarness.reset()
    const revokedProject = await createLifecycleJob(owner, request())
    lifecycleHarness.state.projectOwnerId = 'other-owner'
    await expect(claimLifecycleJobs({ workerEnabled: true })).resolves.toEqual([])
    expect(lifecycleHarness.state.jobs.get(revokedProject.job.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      lastErrorCode: 'claim_authorization_revoked',
    })

    lifecycleHarness.reset()
    const revokedFlag = await createLifecycleJob(owner, request())
    lifecycleHarness.state.flagsEnabled = false
    await expect(claimLifecycleJobs({ workerEnabled: true })).resolves.toEqual([])
    expect(lifecycleHarness.state.jobs.get(revokedFlag.job.id)).toMatchObject({
      status: 'NEEDS_REVIEW',
      attempts: 0,
      lastErrorCode: 'claim_rollout_revoked',
    })
    expect(lifecycleHarness.state.audits.at(-1)).toMatchObject({
      eventType: 'claim_authorization_quarantined',
      metadata: { reason: 'claim_rollout_revoked' },
    })
  })

  it('lets only the owner list/configure an exact scoped flag with audit idempotency', async () => {
    const command = {
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      role: 'creator',
      capability: 'preview',
      enabled: true,
      canaryPercent: 25,
      dualReadEnabled: true,
      legacyFallbackEnabled: true,
      idempotencyKey: 'lifecycle:flag:preview-1',
    }
    const created = await configureLifecycleFeatureFlag(owner, command)
    expect(created).toMatchObject({
      idempotent: false,
      flag: {
        ownerId: 'owner-1',
        brandProfileId: 'brand-1',
        projectId: 'project-1',
        role: 'creator',
        capability: 'preview',
        enabled: true,
        canaryPercent: 25,
        fallbackExecution: 'client_orchestrated',
        execution: {
          configOnly: true,
          paidRenderAllowed: false,
          voiceProviderAllowed: false,
          externalPublishAllowed: false,
        },
      },
    })
    await expect(configureLifecycleFeatureFlag(owner, command)).resolves.toMatchObject({
      idempotent: true,
      flag: { id: created.flag.id },
    })
    await expect(listLifecycleFeatureFlags(owner, command)).resolves.toMatchObject([
      { id: created.flag.id, role: 'creator', capability: 'preview' },
    ])
    expect(lifecycleHarness.state.flagAudits).toHaveLength(1)
    await expect(configureLifecycleFeatureFlag(owner, {
      ...command,
      enabled: false,
    })).rejects.toThrow('idempotency_conflict')
    await expect(configureLifecycleFeatureFlag({
      ...owner,
      userId: 'reviewer-1',
      erpRole: 'STAFF',
    }, command)).rejects.toThrow('lifecycle_flag_owner_required')
    await expect(configureLifecycleFeatureFlag(owner, {
      ...command,
      projectId: 'project-other',
      idempotencyKey: 'lifecycle:flag:preview-2',
    })).rejects.toThrow('project_scope_mismatch')
    await expect(configureLifecycleFeatureFlag(owner, {
      ...command,
      capability: 'unknown',
      idempotencyKey: 'lifecycle:flag:preview-3',
    })).rejects.toThrow('invalid_lifecycle_flag_capability')
    await expect(configureLifecycleFeatureFlag(owner, {
      ...command,
      canaryPercent: 101,
      idempotencyKey: 'lifecycle:flag:preview-4',
    })).rejects.toThrow('invalid_lifecycle_canary_percent')
    await expect(configureLifecycleFeatureFlag(owner, {
      ...command,
      capability: 'live_publish',
      idempotencyKey: 'lifecycle:flag:live-1',
    })).rejects.toThrow('live_publish_execution_disabled')
  })

  it('returns the winning cancel for concurrent identical idempotency keys', async () => {
    lifecycleHarness.insertRunning('job-cancel-race')
    lifecycleHarness.state.jobs.get('job-cancel-race')!.status = 'QUEUED'
    const command = {
      jobId: 'job-cancel-race',
      intent: 'cancel',
      idempotencyKey: 'lifecycle:cancel:race-1',
    }
    const outcomes = await Promise.all([
      controlLifecycleJob(owner, command),
      controlLifecycleJob(owner, command),
    ])
    expect(outcomes.map((entry) => entry.idempotent).sort()).toEqual([false, true])
    expect(outcomes[0].job.status).toBe('canceled')
    expect(outcomes[1].job.status).toBe('canceled')
    expect(lifecycleHarness.state.audits.filter((row) => row.idempotencyKey === command.idempotencyKey))
      .toHaveLength(1)
  })

  it('never reports READY without storage verification and quarantines ambiguity', async () => {
    lifecycleHarness.insertRunning('job-unverified')
    const unverified = await recordLifecycleWorkerResult({
      jobId: 'job-unverified',
      leaseToken: 'lease-job-unverified',
      outcome: 'ready',
      storagePath: 'creative-lifecycle/unverified.json',
      checksum: 'f'.repeat(64),
      sizeBytes: 12,
      operationPackageChecksum: '1'.repeat(64),
      verifier: async () => false,
    })
    expect(unverified).toMatchObject({
      status: 'failed',
      resultStoragePath: null,
      verifiedAt: null,
      lastErrorCode: 'artifact_verification_failed',
    })
    expect(lifecycleHarness.state.receipts.at(-1)).toMatchObject({
      status: 'FAILED',
      artifactVerified: false,
    })

    lifecycleHarness.insertRunning('job-ambiguous')
    const ambiguous = await recordLifecycleWorkerResult({
      jobId: 'job-ambiguous',
      leaseToken: 'lease-job-ambiguous',
      outcome: 'failed',
      ambiguousEffect: true,
    })
    expect(ambiguous).toMatchObject({
      status: 'needs_review',
      lastErrorCode: 'ambiguous_worker_effect',
    })

    lifecycleHarness.insertRunning('job-ready')
    const ready = await recordLifecycleWorkerResult({
      jobId: 'job-ready',
      leaseToken: 'lease-job-ready',
      outcome: 'ready',
      storagePath: 'creative-lifecycle/ready.json',
      checksum: 'f'.repeat(64),
      sizeBytes: 12,
      operationPackageChecksum: '1'.repeat(64),
      verifier: async () => true,
    })
    expect(ready).toMatchObject({
      status: 'ready',
      resultStoragePath: 'creative-lifecycle/ready.json',
      resultChecksum: 'f'.repeat(64),
      resultArtifactVersionId: 'output-version-1',
      progress: { completed: 4, total: 4 },
    })
    expect(lifecycleHarness.state.receipts.at(-1)).toMatchObject({
      status: 'READY',
      artifactVerified: true,
      artifactVersionId: 'output-version-1',
    })
    expect(lifecycleHarness.state.outputVersions[0]).toMatchObject({
      assetId: 'output-asset-1',
      jobId: 'job-ready',
      storagePath: 'creative-lifecycle/ready.json',
      metadata: {
        checksumSha256: 'f'.repeat(64),
        lifecycle: {
          compositionId: 'composition-1',
          compositionVersionId: 'composition-version-2',
          operationBatchId: 'batch-2',
          sourceArtifactVersionId: 'asset-version-2',
          approvedArtifactVersionId: 'asset-version-2',
          renderFingerprint: 'd'.repeat(64),
          operationPackageChecksum: '1'.repeat(64),
          originalStoragePath: 'generated/source.png',
          renderStoragePath: 'creative-lifecycle/ready.json',
        },
      },
    })
    expect(lifecycleHarness.state.outputLineage).toEqual([expect.objectContaining({
      versionId: 'output-version-1',
      sourceAssetId: 'asset-1',
      relationKind: 'lifecycle_render',
    })])
  })

  it('rejects a worker-supplied artifact identity instead of trusting it', async () => {
    lifecycleHarness.insertRunning('job-forged-artifact')
    await expect(recordLifecycleWorkerResult({
      jobId: 'job-forged-artifact',
      leaseToken: 'lease-job-forged-artifact',
      outcome: 'ready',
      storagePath: 'creative-lifecycle/forged.json',
      checksum: 'f'.repeat(64),
      sizeBytes: 12,
      artifactVersionId: 'attacker-version',
      operationPackageChecksum: '1'.repeat(64),
      verifier: async () => true,
    })).rejects.toThrow('worker_artifact_identity_not_authoritative')
    expect(lifecycleHarness.state.outputVersions).toHaveLength(0)
  })
})
