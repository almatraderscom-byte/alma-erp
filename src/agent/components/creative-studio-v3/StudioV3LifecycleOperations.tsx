'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import type { CreativeStudioV3ProductionPort } from '@/agent/components/creative-studio-v3/ports'
import {
  STUDIO_V3_LIFECYCLE_CAPABILITIES,
  type StudioV3LifecycleCapability,
  type StudioV3LifecycleRole,
  type StudioV3LifecycleWorkspace,
} from '@/agent/components/creative-studio-v3/lifecycle-client'
import {
  studioV3LifecycleIdempotencyKey,
  STUDIO_V3_LIFECYCLE_MODE_COPY,
  STUDIO_V3_LIFECYCLE_ROLE_LABEL,
} from '@/agent/components/creative-studio-v3/lifecycle-policy'
import { StudioV3LifecycleModeGrid } from '@/agent/components/creative-studio-v3/StudioV3LifecycleModeGrid'
import { StudioV3Icon } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import type {
  LifecycleFeatureFlagView,
  LifecycleJobView,
} from '@/lib/creative-studio/lifecycle-service'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

export function StudioV3LifecycleOperations({
  activeBrand,
  port,
  project,
}: {
  activeBrand: StudioBrandProfile
  port: CreativeStudioV3ProductionPort
  project: StudioProjectSummary
}) {
  const [workspace, setWorkspace] = useState<StudioV3LifecycleWorkspace | null>(null)
  const [targetRole, setTargetRole] = useState<StudioV3LifecycleRole>('owner')
  const [capability, setCapability] = useState<StudioV3LifecycleCapability>('preview')
  const [flags, setFlags] = useState<LifecycleFeatureFlagView[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadSequence = useRef(0)
  const owner = activeBrand.role === 'owner'

  const loadWorkspace = useCallback(async () => {
    const sequence = ++loadSequence.current
    setError(null)
    try {
      const next = await port.loadWorkspace({
        brandProfileId: activeBrand.brandProfileId,
        projectId: project.id,
      })
      if (sequence === loadSequence.current) setWorkspace(next)
    } catch (reason) {
      if (sequence !== loadSequence.current) return
      setWorkspace(null)
      setError(reason instanceof Error ? reason.message : 'Lifecycle Operations unavailable.')
    }
  }, [activeBrand.brandProfileId, port, project.id])

  useEffect(() => {
    void loadWorkspace()
    return () => { loadSequence.current += 1 }
  }, [loadWorkspace])

  useEffect(() => {
    let live = true
    setFlags([])
    if (!owner) return () => { live = false }
    void port.listFlags({
      brandProfileId: activeBrand.brandProfileId,
      projectId: project.id,
      role: targetRole,
      capability,
    }).then((response) => {
      if (live) setFlags(response.flags)
    }).catch((reason) => {
      if (live) {
        setError(reason instanceof Error ? reason.message : 'Lifecycle flag unavailable.')
      }
    })
    return () => { live = false }
  }, [
    activeBrand.brandProfileId,
    capability,
    owner,
    port,
    project.id,
    targetRole,
  ])

  const selectedFlag = flags[0] ?? null

  const updateFlag = async () => {
    if (!owner) return
    const enabled = !selectedFlag?.enabled
    if (capability === 'live_publish' && enabled) return
    setBusy('flag')
    setError(null)
    try {
      const result = await port.configureFlag({
        actorRole: activeBrand.role,
        brandProfileId: activeBrand.brandProfileId,
        projectId: project.id,
        role: targetRole,
        capability,
        enabled,
        canaryPercent: enabled ? 100 : 0,
        dualReadEnabled: false,
        legacyFallbackEnabled: true,
        idempotencyKey: studioV3LifecycleIdempotencyKey(
          `flag:${targetRole}:${capability}`,
        ),
      })
      setFlags([result.flag])
      await loadWorkspace()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Lifecycle flag update failed.')
    } finally {
      setBusy(null)
    }
  }

  const control = async (job: LifecycleJobView, intent: 'cancel' | 'retry') => {
    if (!owner) return
    setBusy(`${intent}:${job.id}`)
    setError(null)
    try {
      await port.controlJob({
        actorRole: activeBrand.role,
        jobId: job.id,
        intent,
        idempotencyKey: studioV3LifecycleIdempotencyKey(`${intent}:${job.id}`),
      })
      await loadWorkspace()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Lifecycle ${intent} failed.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.lifecycleOperations}>
      {error && (
        <div className={styles.inlineWarning} role="alert">
          <StudioV3Icon name="warning" />
          <span>{error}</span>
        </div>
      )}

      <section aria-label="Lifecycle safety gates" className={styles.lifecycleSafetyGrid}>
        <article data-off="true">
          <span>Paid render</span>
          <strong>HARD OFF</strong>
          <p>No paid method exists in the V3 Lifecycle client.</p>
        </article>
        <article data-off="true">
          <span>Voice provider</span>
          <strong>HARD OFF</strong>
          <p>No voice call is reachable from Review or Operations.</p>
        </article>
        <article data-off="true">
          <span>Live Meta</span>
          <strong>HARD OFF</strong>
          <p>Flag enable and external publish execution are blocked.</p>
        </article>
        <article data-off={workspace?.execution.localWorkerFlagEnabled !== true}>
          <span>Local worker</span>
          <strong>
            {!workspace
              ? 'NOT LOADED'
              : workspace.execution.localWorkerFlagEnabled
                ? 'APP FLAG ON'
                : 'APP FLAG OFF'}
          </strong>
          <p>
            This does not prove a VPS loop is running. Worker heartbeat telemetry remains
            {' '}{workspace?.operations.workerHealth ?? 'unknown'}.
          </p>
        </article>
      </section>

      <StudioV3LifecycleModeGrid role={activeBrand.role} workspace={workspace} />

      <section className={styles.lifecycleMetrics}>
        <header className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Authoritative telemetry</span>
            <h2>Queue and verification</h2>
          </div>
          <button
            aria-label="Refresh Lifecycle Operations"
            className={styles.iconButton}
            disabled={busy !== null}
            onClick={() => void loadWorkspace()}
            type="button"
          >
            <StudioV3Icon name="refresh" />
          </button>
        </header>
        <dl className={styles.lifecycleFacts}>
          <div><dt>Queued jobs</dt><dd>{workspace?.operations.queuedJobs ?? 'Unknown'}</dd></div>
          <div><dt>Oldest queue age</dt><dd>{workspace?.operations.oldestJobAgeMinutes == null ? 'Unknown' : `${workspace.operations.oldestJobAgeMinutes} min`}</dd></div>
          <div><dt>Pending verification</dt><dd>{workspace?.operations.artifactsPendingVerification ?? 'Unknown'}</dd></div>
          <div><dt>Worker heartbeat</dt><dd>{workspace?.operations.workerHeartbeatAgeMinutes == null ? 'Not reported' : `${workspace.operations.workerHeartbeatAgeMinutes} min`}</dd></div>
          <div><dt>Provider balance</dt><dd>{workspace?.operations.providerBalanceBdt == null ? 'Not reported' : `৳${workspace.operations.providerBalanceBdt}`}</dd></div>
          <div><dt>Missing signals</dt><dd>{workspace?.operations.missingSignals.length ?? 'Unknown'}</dd></div>
        </dl>
      </section>

      {owner ? (
        <section className={styles.lifecycleFlagPanel}>
          <header>
            <div>
              <span className={styles.eyebrow}>Owner-scoped configuration</span>
              <h2>Exact rollout / kill switch</h2>
            </div>
            <span>Config only · no execution</span>
          </header>
          <div className={styles.lifecycleFlagFields}>
            <label>
              <span>Target role</span>
              <select onChange={(event) => setTargetRole(event.target.value as StudioV3LifecycleRole)} value={targetRole}>
                {Object.entries(STUDIO_V3_LIFECYCLE_ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>Capability</span>
              <select onChange={(event) => setCapability(event.target.value as StudioV3LifecycleCapability)} value={capability}>
                {STUDIO_V3_LIFECYCLE_CAPABILITIES.map((value) => <option key={value} value={value}>{STUDIO_V3_LIFECYCLE_MODE_COPY[value].label}</option>)}
              </select>
            </label>
            <button
              className={selectedFlag?.enabled ? styles.secondaryButton : styles.primaryButton}
              disabled={busy !== null || (capability === 'live_publish' && !selectedFlag?.enabled)}
              onClick={() => void updateFlag()}
              type="button"
            >
              {selectedFlag?.enabled ? 'Disable exact scope' : 'Enable exact scope'}
            </button>
          </div>
          <p>
            {selectedFlag
              ? `${STUDIO_V3_LIFECYCLE_ROLE_LABEL[targetRole]} · ${STUDIO_V3_LIFECYCLE_MODE_COPY[capability].label} · ${selectedFlag.enabled ? 'enabled' : 'disabled'} · canary ${selectedFlag.canaryPercent}% · legacy fallback ${selectedFlag.legacyFallbackAvailable ? 'available' : 'off'}.`
              : 'No exact project-role flag exists. The evaluated rollout above remains authoritative.'}
            {capability === 'live_publish'
              ? ' Live publish can be inspected or disabled, never enabled from this $0 rollout.'
              : ''}
          </p>
        </section>
      ) : (
        <div className={styles.truthBoundary}>
          <StudioV3Icon name="lock" />
          <div>
            <strong>Owner-scoped controls are read-only</strong>
            <p>{STUDIO_V3_LIFECYCLE_ROLE_LABEL[activeBrand.role]} can inspect exact rollouts, jobs and missing telemetry but cannot mutate flags or jobs.</p>
          </div>
        </div>
      )}

      <section className={styles.lifecycleJobs}>
        <header className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Exact scoped jobs</span>
            <h2>Render and export history</h2>
          </div>
          <span className={styles.sectionMeta}>{workspace?.jobs.length ?? 0} server result{workspace?.jobs.length === 1 ? '' : 's'}</span>
        </header>
        {!workspace ? (
          <p className={styles.emptyState}>Lifecycle job history is not loaded for this scope.</p>
        ) : workspace.jobs.length === 0 ? (
          <p className={styles.emptyState}>No Lifecycle job exists for this exact brand/project scope.</p>
        ) : (
          <div>
            {workspace.jobs.map((job) => (
              <article key={job.id}>
                <header>
                  <strong>{job.kind} · {job.status.replace('_', ' ')}</strong>
                  <em>{job.effectClass} · ৳{job.estimatedCostBdt}</em>
                </header>
                <p>
                  Composition {job.compositionId} · version {job.compositionVersionId}
                  {' '}· source {job.sourceArtifactVersionId}
                </p>
                <small>
                  {job.verifiedAt
                    ? `Verified ${new Date(job.verifiedAt).toLocaleString('en-BD')}`
                    : job.lastErrorCode ?? 'Awaiting verified worker result'}
                </small>
                <div>
                  <button
                    className={styles.textButton}
                    disabled={!owner || busy !== null || !['queued', 'running'].includes(job.status)}
                    onClick={() => void control(job, 'cancel')}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className={styles.textButton}
                    disabled={!owner || busy !== null || job.status !== 'failed'}
                    onClick={() => void control(job, 'retry')}
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
