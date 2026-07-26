'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  StudioBrandProfile,
  StudioReviewState,
  StudioReviewThread,
} from '@/agent/components/creative-studio/studio-api'
import type {
  CreativeStudioV3ProductionPort,
} from '@/agent/components/creative-studio-v3/ports'
import type {
  CreativeStudioV3Navigate,
  CreativeStudioV3ReviewQueueItem,
} from '@/agent/components/creative-studio-v3/types'
import {
  type StudioV3LifecyclePreview,
  type StudioV3LifecycleWorkspace,
} from '@/agent/components/creative-studio-v3/lifecycle-client'
import {
  studioV3LifecycleIdempotencyKey,
  STUDIO_V3_LIFECYCLE_ROLE_LABEL,
} from '@/agent/components/creative-studio-v3/lifecycle-policy'
import { StudioV3LifecycleModeGrid } from '@/agent/components/creative-studio-v3/StudioV3LifecycleModeGrid'
import { galleryViewForReviewItem } from '@/agent/components/creative-studio-v3/ui-contract'
import { StudioV3Icon } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import type { CreativeCompositionSummary } from '@/lib/creative-studio/composition-service'
import type { StudioCompositionPin } from '@/lib/creative-studio/lifecycle-contract'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

function latestPinnedApproval(review: StudioReviewThread | null) {
  if (!review) return null
  return [...review.events].reverse().find((event) => (
    event.toState === 'approved'
    && event.approvedVersionId === review.latestVersionId
    && event.approvedCompositionId === review.approvedCompositionId
    && event.approvedCompositionVersionId === review.approvedCompositionVersionId
  )) ?? null
}

function exactPinnedRequest(input: {
  brandProfileId: string
  projectId: string
  review: StudioReviewThread
  pin: StudioCompositionPin
}) {
  const approval = latestPinnedApproval(input.review)
  if (
    !input.review.publishReady
    || input.review.approvalInvalidatedReason
    || !approval
    || !input.review.latestVersionId
    || approval.approvedCompositionId !== input.pin.compositionId
    || approval.approvedCompositionVersionId !== input.pin.compositionVersionId
    || approval.approvedVersionId !== input.pin.artifactVersionId
  ) return null
  return {
    brandProfileId: input.brandProfileId,
    projectId: input.projectId,
    compositionId: input.pin.compositionId,
    compositionVersionId: input.pin.compositionVersionId,
    sourceArtifactVersionId: input.pin.artifactVersionId,
    approvedReviewEventId: approval.id,
    operationBatchId: input.pin.batchId,
  }
}

export function StudioV3LifecycleReview({
  activeBrand,
  onNavigate,
  onReviewChanged,
  port,
  project,
  reviewItem,
}: {
  activeBrand: StudioBrandProfile
  onNavigate: CreativeStudioV3Navigate
  onReviewChanged: () => Promise<void>
  port: CreativeStudioV3ProductionPort
  project: StudioProjectSummary
  reviewItem: CreativeStudioV3ReviewQueueItem | null
}) {
  const [compositions, setCompositions] = useState<CreativeCompositionSummary[]>([])
  const [compositionId, setCompositionId] = useState('')
  const [review, setReview] = useState<StudioReviewThread | null>(null)
  const [pin, setPin] = useState<StudioCompositionPin | null>(null)
  const [workspace, setWorkspace] = useState<StudioV3LifecycleWorkspace | null>(null)
  const [preview, setPreview] = useState<StudioV3LifecyclePreview | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadSequence = useRef(0)

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    if (!reviewItem) {
      setCompositions([])
      setCompositionId('')
      setReview(null)
      setPin(null)
      setWorkspace(null)
      setPreview(null)
      setError(null)
      return
    }
    setError(null)
    const scope = {
      brandProfileId: activeBrand.brandProfileId,
      projectId: project.id,
    }
    const [compositionResult, reviewResult, workspaceResult] =
      await Promise.allSettled([
        port.listCompositions(scope),
        port.getReview(reviewItem.projectAssetId, activeBrand.brandProfileId),
        port.loadWorkspace(scope),
      ])
    if (sequence !== loadSequence.current) return
    const nextCompositions = compositionResult.status === 'fulfilled'
      ? compositionResult.value
      : []
    const nextReview = reviewResult.status === 'fulfilled'
      ? reviewResult.value
      : null
    setCompositions(nextCompositions)
    setReview(nextReview)
    setWorkspace(workspaceResult.status === 'fulfilled' ? workspaceResult.value : null)
    setCompositionId((current) => {
      const preferred = nextReview?.approvedCompositionId
      if (preferred && nextCompositions.some((item) => item.id === preferred)) {
        return preferred
      }
      return nextCompositions.some((item) => item.id === current)
        ? current
        : nextCompositions[0]?.id ?? ''
    })
    const failures = [compositionResult, reviewResult, workspaceResult]
      .filter((result) => result.status === 'rejected')
      .map((result) => (
        result.status === 'rejected' && result.reason instanceof Error
          ? result.reason.message
          : 'Lifecycle data unavailable.'
      ))
    setError(failures.length ? failures.join(' · ') : null)
  }, [
    activeBrand.brandProfileId,
    port,
    project.id,
    reviewItem,
  ])

  useEffect(() => {
    void load()
    return () => { loadSequence.current += 1 }
  }, [load])

  useEffect(() => {
    let live = true
    setPin(null)
    setPreview(null)
    if (!reviewItem || !compositionId) return () => { live = false }
    void port.resolvePin({
      brandProfileId: activeBrand.brandProfileId,
      projectId: project.id,
      compositionId,
      artifactVersionId: reviewItem.currentVersionId,
    }).then((value) => {
      if (live) setPin(value)
    }).catch((reason) => {
      if (live) {
        setError(reason instanceof Error
          ? reason.message
          : 'The exact composition/version pin is unavailable.')
      }
    })
    return () => { live = false }
  }, [
    activeBrand.brandProfileId,
    compositionId,
    port,
    project.id,
    reviewItem,
  ])

  const pinnedRequest = useMemo(() => (
    review && pin
      ? exactPinnedRequest({
          brandProfileId: activeBrand.brandProfileId,
          projectId: project.id,
          review,
          pin,
        })
      : null
  ), [activeBrand.brandProfileId, pin, project.id, review])
  const owner = activeBrand.role === 'owner'
  const canApprove = owner
    && Boolean(review?.capabilities.approve)
    && (review?.currentState === 'draft' || review?.currentState === 'revised')
    && Boolean(pin)
  const canRequestChanges = owner
    && Boolean(review?.capabilities.requestChanges)
    && (review?.currentState === 'draft' || review?.currentState === 'revised')
  const canMarkRevised = owner
    && Boolean(review?.capabilities.markRevised)
    && (review?.currentState === 'changes_requested' || review?.currentState === 'approved')

  const transition = async (targetState: StudioReviewState) => {
    if (!review || !reviewItem || !owner) return
    if (targetState === 'changes_requested' && !note.trim()) {
      setError('A change request needs a specific note.')
      return
    }
    if (targetState === 'approved' && !pin) {
      setError('The server has not validated an exact composition/version pin.')
      return
    }
    setBusy(`review:${targetState}`)
    setError(null)
    try {
      const updated = await port.transitionReview({
        assetId: reviewItem.projectAssetId,
        brandProfileId: activeBrand.brandProfileId,
        targetState,
        expectedSequence: review.currentSequence,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(targetState === 'approved' && pin
          ? {
              compositionId: pin.compositionId,
              compositionVersionId: pin.compositionVersionId,
            }
          : {}),
      })
      setReview(updated)
      setNote('')
      await onReviewChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Review update failed.')
    } finally {
      setBusy(null)
    }
  }

  const previewLocal = async (kind: 'render' | 'export') => {
    if (!pinnedRequest) return
    setBusy(`preview:${kind}`)
    setError(null)
    try {
      setPreview(await port.previewLocal({ ...pinnedRequest, kind }))
    } catch (reason) {
      setPreview(null)
      setError(reason instanceof Error ? reason.message : 'Lifecycle preview failed.')
    } finally {
      setBusy(null)
    }
  }

  const queueLocal = async (kind: 'render' | 'export') => {
    if (!pinnedRequest || !owner) return
    setBusy(`queue:${kind}`)
    setError(null)
    try {
      await port.queueLocal({
        ...pinnedRequest,
        kind,
        idempotencyKey: studioV3LifecycleIdempotencyKey(
          `${kind}:${pin?.compositionVersionId ?? 'current'}`,
        ),
      })
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Local Lifecycle queue failed.')
    } finally {
      setBusy(null)
    }
  }

  if (!reviewItem) {
    return (
      <div className={styles.emptyState}>
        Select a canonical asset to inspect its Review thread and Lifecycle pins.
      </div>
    )
  }

  return (
    <div className={styles.lifecycleReview}>
      <header className={styles.lifecyclePanelHeader}>
        <div>
          <span className={styles.eyebrow}>Exact review target</span>
          <h2>{review?.assetTitle ?? reviewItem.title ?? 'Untitled project asset'}</h2>
          <p>
            Asset {reviewItem.projectAssetId} · version {reviewItem.currentVersionId}
            {' '}· sequence {reviewItem.expectedSequence}
          </p>
        </div>
        <button
          className={styles.secondaryButton}
          onClick={() => onNavigate(galleryViewForReviewItem(reviewItem))}
          type="button"
        >
          Inspect exact version
        </button>
      </header>

      {error && (
        <div className={styles.inlineWarning} role="alert">
          <StudioV3Icon name="warning" />
          <span>{error}</span>
        </div>
      )}

      <label className={styles.lifecycleField}>
        <span>Canonical composition</span>
        <select
          disabled={compositions.length === 0}
          onChange={(event) => setCompositionId(event.target.value)}
          value={compositionId}
        >
          {compositions.length === 0
            ? <option value="">No accessible composition</option>
            : compositions.map((composition) => (
                <option key={composition.id} value={composition.id}>
                  {composition.title} · v{composition.currentVersion}
                </option>
              ))}
        </select>
      </label>

      <dl className={styles.lifecycleFacts}>
        <div><dt>Review state</dt><dd>{review?.currentState.replace('_', ' ') ?? 'Not hydrated'}</dd></div>
        <div><dt>Publish ready</dt><dd>{review?.publishReady ? 'Exact pin current' : 'No'}</dd></div>
        <div><dt>Composition version</dt><dd>{pin?.compositionVersionId ?? 'Pin not validated'}</dd></div>
        <div><dt>Artifact version</dt><dd>{pin?.artifactVersionId ?? reviewItem.currentVersionId}</dd></div>
        <div><dt>Approval event</dt><dd>{latestPinnedApproval(review)?.id ?? 'No current pinned approval'}</dd></div>
        <div><dt>Invalidation</dt><dd>{review?.approvalInvalidatedReason ?? 'None reported'}</dd></div>
      </dl>

      {!owner && (
        <div className={styles.truthBoundary}>
          <StudioV3Icon name="lock" />
          <div>
            <strong>{STUDIO_V3_LIFECYCLE_ROLE_LABEL[activeBrand.role]} Lifecycle view is read-only</strong>
            <p>Exact pins, rollouts and jobs are visible. V3 does not expose review, queue, control or flag mutations to collaborators.</p>
          </div>
        </div>
      )}

      <fieldset className={styles.lifecycleReviewControls} disabled={!owner || busy !== null}>
        <legend>Owner review mutation</legend>
        <textarea
          maxLength={2000}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Required for change requests; optional for approval or revision."
          value={note}
        />
        <div>
          <button
            className={styles.secondaryButton}
            disabled={!canRequestChanges}
            onClick={() => void transition('changes_requested')}
            type="button"
          >
            Request changes
          </button>
          <button
            className={styles.secondaryButton}
            disabled={!canMarkRevised}
            onClick={() => void transition('revised')}
            type="button"
          >
            Mark revised
          </button>
          <button
            className={styles.primaryButton}
            disabled={!canApprove}
            onClick={() => void transition('approved')}
            type="button"
          >
            Approve exact pin
          </button>
        </div>
      </fieldset>

      <StudioV3LifecycleModeGrid role={activeBrand.role} workspace={workspace} />

      <div className={styles.lifecycleActions}>
        <button
          className={styles.secondaryButton}
          disabled={!pinnedRequest || !workspace?.rollouts.preview.enabled || busy !== null}
          onClick={() => void previewLocal('render')}
          type="button"
        >
          Preview local render
        </button>
        <button
          className={styles.primaryButton}
          disabled={!owner || !pinnedRequest || !workspace?.rollouts.render.enabled || busy !== null}
          onClick={() => void queueLocal('render')}
          type="button"
        >
          Queue ৳0 local render
        </button>
        <button
          className={styles.primaryButton}
          disabled={!owner || !pinnedRequest || !workspace?.rollouts.export.enabled || busy !== null}
          onClick={() => void queueLocal('export')}
          type="button"
        >
          Queue verified export
        </button>
      </div>

      {preview && (
        <div className={styles.lifecycleReceipt} role="status">
          <StudioV3Icon name="check" />
          <div>
            <strong>Server preview only · no job created</strong>
            <p>
              {preview.jobKind} · {preview.compositionVersionId} · {preview.sourceArtifactVersionId}
              {' '}· fingerprint {preview.renderFingerprint}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
