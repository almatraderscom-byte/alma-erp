import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStudioV3LifecycleClient,
  type StudioV3LifecycleWorkspace,
} from '@/agent/components/creative-studio-v3/lifecycle-client'
import {
  lifecyclePresentation,
  lifecycleReviewReadiness,
} from '@/agent/components/creative-studio-v3/lifecycle-policy'

const rollout = {
  enabled: true,
  legacyFallbackAvailable: true,
  fallbackExecution: 'client_orchestrated',
  dualReadEnabled: false,
  canary: 'included',
  matchedFlagId: 'flag-1',
  reason: 'matched',
} as const

const scope = {
  brandProfileId: 'brand-1',
  projectId: 'project-1',
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    jobs: [],
    operations: {
      queuedJobs: 0,
      oldestJobAgeMinutes: 0,
      queueLatencyP95Ms: null,
      rejectedCommands: null,
      staleConflicts: null,
      providerHealth: 'unknown',
      providerErrorRate7d: null,
      providerBalanceBdt: null,
      providerSpendUsd7d: null,
      workerHealth: 'unknown',
      workerHeartbeatAgeMinutes: null,
      artifactsPendingVerification: 0,
      reviewInvalidations7d: null,
      publishOutcomes: {
        published: null,
        failedRetryable: null,
        needsReview: null,
        canceled: null,
      },
      goldenEval: { passed: null, total: null, passRate: null },
      cache: { hitRate: null, staleEntries: null },
      killSwitches: {
        lifecycle: true,
        livePublish: true,
        paidRender: true,
        voiceProvider: true,
      },
      missingSignals: ['workerHeartbeatAgeMinutes'],
    },
    execution: {
      paidRender: false,
      voiceProvider: false,
      externalPublish: false,
      localWorkerFlagEnabled: false,
      legacyFallbackAvailable: true,
      legacyFallbackExecution: 'client_orchestrated',
    },
    rollout,
    rollouts: {
      preview: rollout,
      render: rollout,
      export: rollout,
      dry_run: rollout,
      schedule: rollout,
      live_publish: rollout,
    },
    pin: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Creative Studio V3 Lifecycle client', () => {
  it('loads the exact access scope and rejects a crossed job', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(response(workspace({
      jobs: [{
        id: 'job-1',
        brandProfileId: 'brand-other',
        projectId: 'project-1',
        compositionId: 'composition-1',
      }],
    })))
    const client = createStudioV3LifecycleClient()
    await expect(client.loadWorkspace(scope)).rejects.toMatchObject({
      code: 'lifecycle_scope_mismatch',
      status: 502,
    })
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/assistant/creative-studio/lifecycle?brandProfileId=brand-1&projectId=project-1',
    )
  })

  it('resolves only the requested authoritative composition/artifact pin', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(response(workspace({
      pin: {
        compositionId: 'composition-1',
        compositionVersionId: 'composition-version-4',
        compositionVersion: 4,
        artifactId: 'asset-1',
        artifactVersionId: 'asset-version-7',
        artifactChecksum: 'a'.repeat(64),
        reviewEventId: 'review-9',
        approvedVersionId: 'asset-version-7',
        campaignPackId: null,
        batchId: 'batch-4',
      },
    })))
    const client = createStudioV3LifecycleClient()
    await expect(client.resolvePin({
      ...scope,
      compositionId: 'composition-1',
      artifactVersionId: 'asset-version-7',
    })).resolves.toMatchObject({
      compositionVersionId: 'composition-version-4',
      artifactVersionId: 'asset-version-7',
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'compositionId=composition-1&artifactVersionId=asset-version-7',
    )
  })

  it('builds only a zero-cost local preview and queue request', async () => {
    const fetchMock = vi.mocked(fetch)
    const pinned = {
      ...scope,
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-4',
      sourceArtifactVersionId: 'asset-version-7',
      approvedReviewEventId: 'review-9',
      operationBatchId: 'batch-4',
    }
    fetchMock
      .mockResolvedValueOnce(response({
        preview: {
          mode: 'preview',
          externalEffect: false,
          jobKind: 'render',
          effectClass: 'zero_cost_local',
          estimatedCostBdt: 0,
          renderProfile: 'composition-manifest-v1',
          outputFormat: 'json',
          rendererVersion: 'composition-manifest-v1',
          paidExecutionAllowed: false,
          compositionId: 'composition-1',
          compositionVersionId: 'composition-version-4',
          compositionVersion: 4,
          compositionDocumentHash: 'b'.repeat(64),
          sourceArtifactVersionId: 'asset-version-7',
          approvedReviewEventId: 'review-9',
          reviewFingerprint: 'c'.repeat(64),
          renderFingerprint: 'd'.repeat(64),
        },
      }))
      .mockResolvedValueOnce(response({
        idempotent: false,
        job: {
          id: 'job-1',
          brandProfileId: 'brand-1',
          projectId: 'project-1',
          compositionId: 'composition-1',
          effectClass: 'zero_cost_local',
          estimatedCostBdt: 0,
          paidExecutionAllowed: false,
        },
      }, 201))
    const client = createStudioV3LifecycleClient()
    await client.previewLocal({ ...pinned, actorRole: 'owner', kind: 'render' })
    await client.queueLocal({
      ...pinned,
      actorRole: 'owner',
      kind: 'export',
      idempotencyKey: 'lifecycle:export:test-1',
    })

    const previewBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    const queueBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    for (const body of [previewBody, queueBody]) {
      expect(body).toMatchObject({
        effectClass: 'zero_cost_local',
        estimatedCostBdt: 0,
        renderProfile: 'composition-manifest-v1',
        outputFormat: 'json',
        rendererVersion: 'composition-manifest-v1',
      })
      expect(body).not.toHaveProperty('confirmedPaidExecution')
      expect(body).not.toHaveProperty('provider')
      expect(body).not.toHaveProperty('publish')
      expect(body).not.toHaveProperty('actorRole')
    }
  })

  it('keeps the client role as presentation-only and omits it from owner flag mutations', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(response({
      idempotent: false,
      flag: { id: 'flag-1', enabled: false },
    }, 201))
    const client = createStudioV3LifecycleClient()
    await client.configureFlag({
      ...scope,
      actorRole: 'owner',
      role: 'creator',
      capability: 'preview',
      enabled: false,
      canaryPercent: 0,
      dualReadEnabled: false,
      legacyFallbackEnabled: true,
      idempotencyKey: 'lifecycle:owner:flag-1',
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      role: 'creator',
      capability: 'preview',
      enabled: false,
    })
    expect(body).not.toHaveProperty('actorRole')
  })

  it('uses the owner-only Lifecycle Review route with exact pins and no serialized role', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(response({
      review: {
        assetId: 'asset-1',
        currentState: 'approved',
        currentSequence: 8,
        publishReady: true,
      },
    }))
    const client = createStudioV3LifecycleClient()
    await client.transitionReview({
      ...scope,
      actorRole: 'owner',
      assetId: 'asset-1',
      targetState: 'approved',
      expectedSequence: 7,
      note: 'Exact pin approved',
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-4',
    })

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/assistant/creative-studio/lifecycle/review/asset-1',
    )
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PATCH' })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({
      brandProfileId: 'brand-1',
      targetState: 'approved',
      expectedSequence: 7,
      note: 'Exact pin approved',
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-4',
    })
    expect(body).not.toHaveProperty('actorRole')
  })

  it('has no live-publish execution method and blocks live flag enable before fetch', async () => {
    const fetchMock = vi.mocked(fetch)
    const client = createStudioV3LifecycleClient()
    expect(client).not.toHaveProperty('publish')
    expect(client).not.toHaveProperty('schedule')
    expect(client).not.toHaveProperty('voice')
    await expect(client.configureFlag({
      ...scope,
      actorRole: 'owner',
      role: 'owner',
      capability: 'live_publish',
      enabled: true,
      canaryPercent: 100,
      dualReadEnabled: false,
      legacyFallbackEnabled: true,
      idempotencyKey: 'lifecycle:flag:live-test',
    })).rejects.toMatchObject({
      code: 'live_publish_execution_disabled',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['creator', 'reviewer'] as const)(
    'rejects every %s mutation before issuing a public request while preserving GET methods',
    async (actorRole) => {
      const fetchMock = vi.mocked(fetch)
      const client = createStudioV3LifecycleClient()
      const pinned = {
        ...scope,
        actorRole,
        compositionId: 'composition-1',
        compositionVersionId: 'composition-version-4',
        sourceArtifactVersionId: 'asset-version-7',
      }

      await expect(client.previewLocal({
        ...pinned,
        kind: 'render',
      })).rejects.toMatchObject({
        code: 'lifecycle_owner_required',
        status: 403,
      })
      await expect(client.transitionReview({
        ...scope,
        actorRole,
        assetId: 'asset-1',
        targetState: 'approved',
        expectedSequence: 7,
        compositionId: 'composition-1',
        compositionVersionId: 'composition-version-4',
      })).rejects.toMatchObject({ code: 'lifecycle_owner_required' })
      await expect(client.queueLocal({
        ...pinned,
        kind: 'render',
        idempotencyKey: `lifecycle:${actorRole}:render-1`,
      })).rejects.toMatchObject({ code: 'lifecycle_owner_required' })
      await expect(client.queueLocal({
        ...pinned,
        kind: 'export',
        idempotencyKey: `lifecycle:${actorRole}:export-1`,
      })).rejects.toMatchObject({ code: 'lifecycle_owner_required' })
      await expect(client.controlJob({
        actorRole,
        jobId: 'job-owner-1',
        intent: 'cancel',
        idempotencyKey: `lifecycle:${actorRole}:cancel-1`,
      })).rejects.toMatchObject({ code: 'lifecycle_owner_required' })
      await expect(client.controlJob({
        actorRole,
        jobId: 'job-owner-1',
        intent: 'retry',
        idempotencyKey: `lifecycle:${actorRole}:retry-1`,
      })).rejects.toMatchObject({ code: 'lifecycle_owner_required' })
      await expect(client.configureFlag({
        ...scope,
        actorRole,
        role: actorRole,
        capability: 'preview',
        enabled: false,
        canaryPercent: 0,
        dualReadEnabled: false,
        legacyFallbackEnabled: true,
        idempotencyKey: `lifecycle:${actorRole}:flag-1`,
      })).rejects.toMatchObject({ code: 'lifecycle_owner_required' })

      expect(fetchMock).not.toHaveBeenCalled()
      fetchMock.mockResolvedValueOnce(response(workspace()))
      await expect(client.loadWorkspace(scope)).resolves.toMatchObject({
        jobs: [],
        operations: { queuedJobs: 0 },
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: 'GET',
        cache: 'no-store',
      })
    },
  )
})

describe('Lifecycle role presentation', () => {
  const loaded = workspace() as StudioV3LifecycleWorkspace

  it('keeps creator and reviewer mutations read-only despite server visibility', () => {
    expect(lifecyclePresentation({
      capability: 'render',
      role: 'creator',
      workspace: loaded,
    })).toMatchObject({
      enabled: true,
      executable: false,
      ownerMutation: false,
      status: 'Read only',
    })
    expect(lifecyclePresentation({
      capability: 'export',
      role: 'reviewer',
      workspace: loaded,
    })).toMatchObject({
      enabled: true,
      executable: false,
      ownerMutation: false,
      status: 'Read only',
    })
  })

  it('keeps dry-run, schedule and live publish visibly distinct and non-executable', () => {
    expect(lifecyclePresentation({
      capability: 'dry_run',
      role: 'owner',
      workspace: loaded,
    })).toMatchObject({
      executable: false,
      status: 'Flag admitted · adapter unavailable',
    })
    expect(lifecyclePresentation({
      capability: 'schedule',
      role: 'owner',
      workspace: loaded,
    }).executable).toBe(false)
    expect(lifecyclePresentation({
      capability: 'live_publish',
      role: 'owner',
      workspace: loaded,
    })).toMatchObject({
      enabled: false,
      executable: false,
      status: 'Hard off',
    })
  })
})

describe('Lifecycle Review readiness presentation', () => {
  it('renders a missing composition pin as explicitly not publish-ready', () => {
    expect(lifecycleReviewReadiness({
      publishReady: false,
      approvalInvalidatedReason: 'composition_pin_missing',
    })).toEqual({
      status: 'Pin missing · not publish-ready',
      invalidation: 'Composition pin missing',
    })
    expect(lifecycleReviewReadiness({
      publishReady: true,
      approvalInvalidatedReason: 'composition_pin_missing',
    }).status).not.toBe('Exact pin current')
  })

  it('uses exact-current copy only for an uninvalidated publish-ready pin', () => {
    expect(lifecycleReviewReadiness({
      publishReady: true,
      approvalInvalidatedReason: null,
    })).toEqual({
      status: 'Exact pin current',
      invalidation: 'None reported',
    })
    expect(lifecycleReviewReadiness({
      publishReady: false,
      approvalInvalidatedReason: 'approved_composition_version_stale',
    }).status).toBe('Not publish-ready')
  })
})
