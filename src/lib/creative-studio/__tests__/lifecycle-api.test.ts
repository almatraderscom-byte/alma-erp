import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycleApiHarness = vi.hoisted(() => ({
  actor: {
    userId: 'owner-1',
    name: 'Owner',
    email: null,
    erpRole: 'SUPER_ADMIN',
  },
  disabled: null as Response | null,
  jobs: vi.fn(),
  operations: vi.fn(),
  rollout: vi.fn(),
  pin: vi.fn(),
  preview: vi.fn(),
  queue: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({
  requireAgentEnabled: vi.fn(() => lifecycleApiHarness.disabled),
}))

vi.mock('@/lib/creative-studio/studio-access', () => ({
  authenticateStudioRequest: vi.fn(async () => lifecycleApiHarness.actor),
  studioAccessErrorResponse: vi.fn(() =>
    Response.json({ error: 'access_error' }, { status: 403 })),
}))

vi.mock('@/lib/creative-studio/lifecycle-service', () => ({
  listLifecycleJobs: lifecycleApiHarness.jobs,
  getLifecycleOperations: lifecycleApiHarness.operations,
  getLifecycleRolloutDecision: lifecycleApiHarness.rollout,
  resolveLifecycleCompositionPin: lifecycleApiHarness.pin,
  previewLifecycleJob: lifecycleApiHarness.preview,
  createLifecycleJob: lifecycleApiHarness.queue,
  lifecycleServiceErrorResponse: vi.fn(() =>
    Response.json({ error: 'service_error' }, { status: 422 })),
}))

import {
  GET,
  POST,
} from '@/app/api/assistant/creative-studio/lifecycle/route'

const rollout = {
  enabled: false,
  legacyFallbackAvailable: true,
  fallbackExecution: 'client_orchestrated',
  dualReadEnabled: false,
  canary: 'not_configured',
  matchedFlagId: null,
  reason: 'default_off',
}

beforeEach(() => {
  lifecycleApiHarness.disabled = null
  lifecycleApiHarness.jobs.mockReset().mockResolvedValue([])
  lifecycleApiHarness.operations.mockReset().mockResolvedValue({
    queuedJobs: 0,
    workerHealth: 'unknown',
    missingSignals: ['workerHeartbeatAgeMinutes'],
  })
  lifecycleApiHarness.rollout.mockReset().mockImplementation(
    async (_actor, input: { capability: string }) => ({
      ...rollout,
      capability: input.capability,
    }),
  )
  lifecycleApiHarness.pin.mockReset().mockResolvedValue({
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
  })
  lifecycleApiHarness.preview.mockReset().mockResolvedValue({ mode: 'preview' })
  lifecycleApiHarness.queue.mockReset().mockResolvedValue({
    idempotent: false,
    job: { id: 'job-1' },
  })
  delete process.env.STUDIO_LIFECYCLE_LOCAL_WORKER_ENABLED
})

describe('Creative Lifecycle production API', () => {
  it('returns all six independently evaluated rollouts and hard-off execution truth', async () => {
    const response = await GET(new NextRequest(
      'http://local/api/assistant/creative-studio/lifecycle'
      + '?brandProfileId=brand-1&projectId=project-1',
    ))
    expect(response.status).toBe(200)
    expect(lifecycleApiHarness.rollout.mock.calls.map((call) => call[1].capability))
      .toEqual([
        'preview',
        'render',
        'export',
        'dry_run',
        'schedule',
        'live_publish',
      ])
    await expect(response.json()).resolves.toMatchObject({
      execution: {
        paidRender: false,
        voiceProvider: false,
        externalPublish: false,
        localWorkerFlagEnabled: false,
        legacyFallbackExecution: 'client_orchestrated',
      },
      rollouts: {
        preview: { capability: 'preview' },
        render: { capability: 'render' },
        export: { capability: 'export' },
        dry_run: { capability: 'dry_run' },
        schedule: { capability: 'schedule' },
        live_publish: { capability: 'live_publish' },
      },
      pin: null,
    })
  })

  it('resolves the exact composition/artifact pin with authenticated server identity', async () => {
    const response = await GET(new NextRequest(
      'http://local/api/assistant/creative-studio/lifecycle'
      + '?brandProfileId=brand-1&projectId=project-1'
      + '&compositionId=composition-1&artifactVersionId=asset-version-7',
    ))
    expect(response.status).toBe(200)
    expect(lifecycleApiHarness.pin).toHaveBeenCalledWith(
      lifecycleApiHarness.actor,
      {
        brandProfileId: 'brand-1',
        projectId: 'project-1',
        compositionId: 'composition-1',
        artifactVersionId: 'asset-version-7',
      },
    )
    await expect(response.json()).resolves.toMatchObject({
      pin: {
        compositionId: 'composition-1',
        compositionVersionId: 'composition-version-4',
        artifactVersionId: 'asset-version-7',
      },
    })
  })

  it('rejects an artifact-only query before pin resolution', async () => {
    const response = await GET(new NextRequest(
      'http://local/api/assistant/creative-studio/lifecycle'
      + '?brandProfileId=brand-1&projectId=project-1'
      + '&artifactVersionId=asset-version-7',
    ))
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      error: 'composition_id_required',
    })
    expect(lifecycleApiHarness.pin).not.toHaveBeenCalled()
  })

  it('passes preview and queue bodies to server-authoritative services unchanged', async () => {
    const previewBody = {
      intent: 'preview',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      compositionId: 'composition-1',
    }
    const previewResponse = await POST(new NextRequest(
      'http://local/api/assistant/creative-studio/lifecycle',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(previewBody),
      },
    ))
    expect(previewResponse.status).toBe(200)
    expect(lifecycleApiHarness.preview).toHaveBeenCalledWith(
      lifecycleApiHarness.actor,
      previewBody,
    )

    const queueBody = {
      ...previewBody,
      intent: 'queue',
      idempotencyKey: 'lifecycle:queue:test-1',
    }
    const queueResponse = await POST(new NextRequest(
      'http://local/api/assistant/creative-studio/lifecycle',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(queueBody),
      },
    ))
    expect(queueResponse.status).toBe(201)
    expect(lifecycleApiHarness.queue).toHaveBeenCalledWith(
      lifecycleApiHarness.actor,
      queueBody,
    )
  })
})
