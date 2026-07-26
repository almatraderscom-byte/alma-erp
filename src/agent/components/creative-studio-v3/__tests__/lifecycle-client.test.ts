import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStudioV3LifecycleClient,
  type StudioV3LifecycleWorkspace,
} from '@/agent/components/creative-studio-v3/lifecycle-client'
import { lifecyclePresentation } from '@/agent/components/creative-studio-v3/lifecycle-policy'

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
    await client.previewLocal({ ...pinned, kind: 'render' })
    await client.queueLocal({
      ...pinned,
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
    }
  })

  it('has no live-publish execution method and blocks live flag enable before fetch', async () => {
    const fetchMock = vi.mocked(fetch)
    const client = createStudioV3LifecycleClient()
    expect(client).not.toHaveProperty('publish')
    expect(client).not.toHaveProperty('schedule')
    expect(client).not.toHaveProperty('voice')
    await expect(client.configureFlag({
      ...scope,
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
      ownerMutation: false,
      status: 'Read only',
    })
    expect(lifecyclePresentation({
      capability: 'export',
      role: 'reviewer',
      workspace: loaded,
    })).toMatchObject({
      enabled: true,
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
