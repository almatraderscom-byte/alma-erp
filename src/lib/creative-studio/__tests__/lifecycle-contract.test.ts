import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  assertArchiveFetchBackManifest,
  assertLifecycleReviewPin,
  assertStudioLifecycleCapability,
  buildStudioRenderFingerprint,
  lifecycleExternalEffectDecision,
  renderProgress,
  StudioLifecycleError,
  type StudioCompositionPin,
} from '@/lib/creative-studio/lifecycle-contract'
import {
  createStudioLifecycleIntent,
  toStudioLifecycleView,
  type StudioFoundationLifecyclePort,
} from '@/lib/creative-studio/lifecycle-adapters'
import {
  buildStudioLifecycleAttribution,
  certifyStudioLifecycleRollback,
  compareStudioLifecycleDualRead,
  DEFAULT_STUDIO_LIFECYCLE_FLAGS,
  evaluateStudioLifecycleRollout,
  toStudioLifecycleOperationsView,
} from '@/lib/creative-studio/lifecycle-rollout'

const pin: StudioCompositionPin = {
  compositionId: 'composition-1', compositionVersionId: 'composition-v4', compositionVersion: 4,
  artifactId: 'asset-1', artifactVersionId: 'asset-v4', artifactChecksum: 'a'.repeat(64),
  reviewEventId: 'review-4', approvedVersionId: 'asset-v4', campaignPackId: 'pack-1', batchId: 'batch-1',
}

const foundation: StudioFoundationLifecyclePort = {
  async getCompositionPin() { return pin },
  async getReviewSnapshot() {
    return {
      assetId: 'asset-1', state: 'approved' as const, latestVersionId: 'asset-v4',
      approvedReviewEventId: 'review-4', approvedVersionId: 'asset-v4',
      approvedCompositionId: 'composition-1', approvedCompositionVersionId: 'composition-v4',
    }
  },
}

describe('V3 lifecycle boundary', () => {
  it('enforces role capabilities before the Foundation port is used', () => {
    for (const role of ['creator', 'reviewer'] as const) {
      for (const capability of [
        'preview',
        'render',
        'export',
        'cancel',
        'retry',
        'live_publish',
      ] as const) {
        expect(() => assertStudioLifecycleCapability(role, capability))
          .toThrow('studio_lifecycle_forbidden')
      }
      expect(() => assertStudioLifecycleCapability(role, 'inspect_operations'))
        .not.toThrow()
    }
    expect(() => assertStudioLifecycleCapability('owner', 'live_publish')).not.toThrow()
    expect(() => assertStudioLifecycleCapability('creator', 'render'))
      .toThrow(StudioLifecycleError)
  })

  it('pins review to exact artifact and composition versions', () => {
    const review = {
      assetId: 'asset-1', state: 'approved' as const, latestVersionId: 'asset-v4',
      approvedReviewEventId: 'review-4', approvedVersionId: 'asset-v4',
      approvedCompositionId: 'composition-1', approvedCompositionVersionId: 'composition-v4',
    }
    expect(() => assertLifecycleReviewPin(pin, review)).not.toThrow()
    expect(() => assertLifecycleReviewPin(pin, { ...review, latestVersionId: 'asset-v5' }))
      .toThrow('review_version_invalidated')
    expect(() => assertLifecycleReviewPin(pin, { ...review, approvedCompositionVersionId: 'composition-v5' }))
      .toThrow('review_composition_version_invalidated')
  })

  it('requires finite schedule ISO and explicit owner acknowledgement while executing nothing', async () => {
    const preview = await createStudioLifecycleIntent({ foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'preview' })
    const scheduled = await createStudioLifecycleIntent({
      foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'schedule',
      scheduleAt: '2026-08-01T10:00:00.000Z', ownerAcknowledged: true,
    })
    const live = await createStudioLifecycleIntent({
      foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'live_publish', ownerAcknowledged: true,
    })
    expect(preview).toMatchObject({ externalEffect: false, executionGate: { executionAllowed: false } })
    expect(scheduled).toMatchObject({ scheduleAt: '2026-08-01T10:00:00.000Z', executionGate: { ownerAcknowledged: true, executionAllowed: false } })
    expect(live).toMatchObject({ externalEffect: true, executionGate: { ownerAcknowledged: true, executionAllowed: false } })
    await expect(createStudioLifecycleIntent({
      foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'schedule', scheduleAt: 'invalid', ownerAcknowledged: true,
    })).rejects.toThrow('schedule_at_invalid')
    await expect(createStudioLifecycleIntent({
      foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'schedule', scheduleAt: '2026-02-31T10:00:00.000Z', ownerAcknowledged: true,
    })).rejects.toThrow('schedule_at_invalid')
    await expect(createStudioLifecycleIntent({
      foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'schedule', scheduleAt: '2026-08-01T10:00:00.000Z',
    })).rejects.toThrow('owner_execution_acknowledgement_required')
  })

  it('keeps new intents planned and inhibits adversarial caller status claims', async () => {
    const intent = await createStudioLifecycleIntent({
      foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'schedule',
      scheduleAt: '2026-08-01T10:00:00.000Z', ownerAcknowledged: true,
    })
    expect(toStudioLifecycleView(intent, { status: 'published' } as never).status).toBe('planned')
    expect(toStudioLifecycleView(intent, { receipt: {
      kind: 'published', intentFingerprint: intent.fingerprint, compositionVersionId: 'composition-v4', artifactVersionId: 'asset-v4',
      verifiedAt: 'not-a-date', externalObjectId: 'meta-1',
    } }).status).toBe('planned')
    expect(toStudioLifecycleView(intent, { receipt: {
      kind: 'scheduled', intentFingerprint: intent.fingerprint, compositionVersionId: 'composition-v4', artifactVersionId: 'asset-v4',
      verifiedAt: '2026-08-01T10:01:00.000Z',
    } })).toMatchObject({ status: 'scheduled', receiptVerified: true })
    expect(toStudioLifecycleView(intent, { receipt: {
      kind: 'published', intentFingerprint: intent.fingerprint, compositionVersionId: 'composition-v4', artifactVersionId: 'asset-v4',
      verifiedAt: '2026-08-01T10:01:00.000Z', externalObjectId: 'meta-1',
    } })).toMatchObject({ status: 'planned', receiptVerified: false, reason: 'receipt_kind_not_valid_for_intent' })
    const live = await createStudioLifecycleIntent({
      foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'live_publish', ownerAcknowledged: true,
    })
    expect(toStudioLifecycleView(live, { receipt: {
      kind: 'published', intentFingerprint: live.fingerprint, compositionVersionId: 'composition-v4', artifactVersionId: 'asset-v4',
      verifiedAt: '2026-08-01T10:01:00.000Z', externalObjectId: 'meta-1',
    } })).toMatchObject({ status: 'published', receiptVerified: true })
    const render = await createStudioLifecycleIntent({
      foundation, actorId: 'owner-1', role: 'owner', compositionId: 'composition-1', mode: 'render',
    })
    expect(toStudioLifecycleView(render, { receipt: {
      kind: 'scheduled', intentFingerprint: render.fingerprint, compositionVersionId: 'composition-v4', artifactVersionId: 'asset-v4',
      verifiedAt: '2026-08-01T10:01:00.000Z',
    } })).toMatchObject({ status: 'planned', receiptVerified: false, reason: 'receipt_kind_not_valid_for_intent' })
  })

  it('uses a stable render fingerprint and truthful progress', () => {
    const first = buildStudioRenderFingerprint({ pin, renderProfile: '1080p', outputFormat: 'mp4', rendererVersion: 'v3' })
    expect(first).toBe(buildStudioRenderFingerprint({ pin: { ...pin }, renderProfile: '1080p', outputFormat: 'mp4', rendererVersion: 'v3' }))
    expect(renderProgress({ stage: 'rendering', completedSteps: 5, totalSteps: 5 })).toMatchObject({ completedSteps: 4, terminal: false })
    expect(renderProgress({ stage: 'complete', completedSteps: 0, totalSteps: 5 })).toMatchObject({ completedSteps: 5, terminal: true })
  })

  it('permits retry only after confirmed no-effect and quarantines ambiguity', () => {
    expect(lifecycleExternalEffectDecision({ providerConfirmedNoEffect: true }).status).toBe('failed_retryable')
    expect(lifecycleExternalEffectDecision({ externalObjectId: 'meta-1' }).status).toBe('needs_review')
    expect(lifecycleExternalEffectDecision({ externalObjectId: 'meta-1', verified: true }).status).toBe('published')
  })

  it('retains exact composition attribution and checksum-verified archive manifests', () => {
    expect(buildStudioLifecycleAttribution({ eventId: 'event-1', pin, lifecycleFingerprint: 'f'.repeat(64) }))
      .toMatchObject({ compositionVersionId: 'composition-v4', artifactVersionId: 'asset-v4', campaignPackId: 'pack-1', batchId: 'batch-1' })
    expect(() => assertArchiveFetchBackManifest({
      compositionId: pin.compositionId, compositionVersionId: pin.compositionVersionId, compositionVersion: pin.compositionVersion,
      compositionDocumentHash: 'd'.repeat(64), operationBatchId: pin.batchId, operationPackageChecksum: 'e'.repeat(64),
      artifactVersionId: pin.artifactVersionId, artifactChecksum: pin.artifactChecksum,
      archiveChecksum: pin.artifactChecksum, fetchBackChecksum: pin.artifactChecksum,
      storagePath: 'agent-files/render.mp4', playableProxyPath: 'agent-files/proxy.mp4',
      originalStoragePath: 'agent-files/original.mp4', renderStoragePath: 'agent-files/render.mp4', driveFileId: 'drive-1',
      fetchedBackAt: '2026-07-26T00:00:00.000Z', verifiedAt: '2026-07-26T00:00:00.000Z',
    })).not.toThrow()
  })

  it('uses owner/brand/project/role/capability scoped canaries, default-off and legacy-on', () => {
    const scope = { ownerId: 'owner-1', brandProfileId: 'brand-1', projectId: 'project-1', role: 'owner' as const, capability: 'render' as const }
    expect(evaluateStudioLifecycleRollout({ scope, flags: [] })).toEqual({
      enabled: false,
      legacyFallbackAvailable: true,
      fallbackExecution: 'client_orchestrated',
      dualReadEnabled: false,
      canary: 'not_configured',
      matchedFlagId: null,
      reason: 'default_off',
    })
    expect(evaluateStudioLifecycleRollout({ scope, flags: [
      { id: 'owner-wide', scope: { ownerId: 'owner-1' }, enabled: true, canaryPercent: 100 },
      { id: 'exact-render', scope, enabled: true, dualReadEnabled: true, canaryPercent: 100 },
    ] })).toMatchObject({ enabled: true, dualReadEnabled: true, canary: 'included', matchedFlagId: 'exact-render' })
    expect(evaluateStudioLifecycleRollout({ scope, flags: [{ id: 'excluded', scope, enabled: true, canaryPercent: 0 }] }))
      .toMatchObject({ enabled: false, legacyFallbackAvailable: true, canary: 'excluded' })
    expect(evaluateStudioLifecycleRollout({
      scope,
      flags: [
        { id: 'duplicate-a', scope, enabled: true, canaryPercent: 100 },
        { id: 'duplicate-b', scope, enabled: true, canaryPercent: 100 },
      ],
    })).toMatchObject({
      enabled: false,
      matchedFlagId: null,
      reason: 'duplicate_scope_ambiguous',
    })
  })

  it('keeps rollback additive and reports every owned rollout operation signal', () => {
    expect(compareStudioLifecycleDualRead({ legacy: { id: 'a', version: 1 }, lifecycle: { version: 1, id: 'a' } }).equal).toBe(true)
    expect(certifyStudioLifecycleRollback({ flags: DEFAULT_STUDIO_LIFECYCLE_FLAGS, pendingExternalEffects: 0, ambiguousEffects: 0 }).certified).toBe(true)
    expect(toStudioLifecycleOperationsView({
      queuedJobs: 4, oldestJobAgeMinutes: 9, queueLatencyP95Ms: 950, rejectedCommands: 3, staleConflicts: 2,
      providerErrorRate7d: 0.11, providerBalanceBdt: 1000.4, providerSpendUsd7d: 4.25, workerHeartbeatAgeMinutes: 16,
      artifactsPendingVerification: 6, reviewInvalidations7d: 1,
      publishOutcomes: { published: 2, failedRetryable: 1, needsReview: 3, canceled: 4 },
      goldenEval: { passed: 9, total: 10 }, cache: { hitRate: 0.8, staleEntries: 2 },
      flags: { ...DEFAULT_STUDIO_LIFECYCLE_FLAGS, lifecycleEnabled: true },
    })).toMatchObject({
      providerHealth: 'critical', providerBalanceBdt: 1000, workerHealth: 'offline', rejectedCommands: 3, staleConflicts: 2,
      artifactsPendingVerification: 6, reviewInvalidations7d: 1, goldenEval: { passed: 9, total: 10, passRate: 0.9 },
      cache: { hitRate: 0.8, staleEntries: 2 }, killSwitches: { lifecycle: false, livePublish: true, paidRender: true, voiceProvider: true },
    })
  })

  it('preserves missing telemetry as unknown/null instead of pretending it is healthy or zero', () => {
    expect(toStudioLifecycleOperationsView({})).toMatchObject({
      queuedJobs: null, queueLatencyP95Ms: null, rejectedCommands: null, staleConflicts: null,
      providerErrorRate7d: null, providerHealth: 'unknown', providerSpendUsd7d: null,
      artifactsPendingVerification: null, reviewInvalidations7d: null,
      publishOutcomes: { published: null, failedRetryable: null, needsReview: null, canceled: null },
      goldenEval: { passed: null, total: null, passRate: null }, cache: { hitRate: null, staleEntries: null },
    })
    expect(toStudioLifecycleOperationsView({}).missingSignals).toContain('providerErrorRate7d')
  })

  it('runs the read-only migration CLI reconciliation over all roadmap fields', () => {
    const output = execFileSync('node', [
      'scripts/creative-studio-lifecycle-migration-dry-run.mjs',
      'src/lib/creative-studio/__tests__/fixtures/lifecycle-migration-dry-run.json',
    ], { cwd: process.cwd(), encoding: 'utf8' })
    const report = JSON.parse(output) as { ok: boolean; productionMutation: boolean; networkAccess: boolean; roadmapReconciliation: { mismatchCount: number; counts: Record<string, { sourceDefined: number }> } }
    expect(report).toMatchObject({ ok: true, productionMutation: false, networkAccess: false, roadmapReconciliation: { mismatchCount: 0 } })
    expect(report.roadmapReconciliation.counts).toMatchObject({ ownerId: { sourceDefined: 1 }, publishState: { sourceDefined: 1 } })
  })

  it('keeps DDL validation held and makes no unproven low-lock claim', () => {
    const output = execFileSync('node', [
      'scripts/creative-studio-lifecycle-ddl-preflight.mjs',
    ], { cwd: process.cwd(), encoding: 'utf8' })
    const report = JSON.parse(output) as {
      ok: boolean
      productionMutation: boolean
      networkAccess: boolean
      representativeDatabaseRehearsal: string
      lowLockProof: boolean
      checks: { validationHeldOutsideDeploy: boolean }
    }
    expect(report).toMatchObject({
      ok: true,
      productionMutation: false,
      networkAccess: false,
      representativeDatabaseRehearsal: 'not_run',
      lowLockProof: false,
      checks: { validationHeldOutsideDeploy: true },
    })
  })
})
