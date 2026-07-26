'use client'

import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { artifactDimensionLabel } from '@/lib/creative-studio/artifact-metadata'
import type {
  EditorActor,
  EditorClip,
  EditorCommandReceipt,
  EditorCompositionSnapshot,
  EditorLocalOperation,
  EditorOperationProposal,
} from '@/lib/creative-studio/editor-agent'
import { CreativeAgentPanel } from './CreativeAgentPanel'
import { EditorIcon } from './EditorIcon'
import { formatEditorTime, selectedEditorClip } from './editor-utils'
import type {
  EditorSelection,
  EditorWorkbenchTab,
  PendingActionRequestHandler,
} from './ui-types'
import styles from './ProjectEditor.module.css'

const TABS: ReadonlyArray<{
  id: EditorWorkbenchTab
  label: string
  icon: 'inspector' | 'agent' | 'review' | 'activity'
}> = [
  { id: 'inspector', label: 'Inspector', icon: 'inspector' },
  { id: 'agent', label: 'Agent', icon: 'agent' },
  { id: 'review', label: 'Review', icon: 'review' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
]

type InspectorDraft = {
  text: string
  startSec: number
  endSec: number
  sourceStartSec: number
  sourceEndSec: number
  volume: number
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
}

export function EditorWorkbench({
  acknowledged,
  actor,
  busy,
  instruction,
  lastReceipt,
  onAcknowledgedChange,
  onApplyAgentPlan,
  onApplyOperations,
  onInstructionChange,
  onPlan,
  onRequestPendingAction,
  onTabChange,
  proposal,
  regionRef,
  selectedAssetId,
  selection,
  snapshot,
  stale,
  tab,
}: {
  acknowledged: boolean
  actor: EditorActor
  busy: boolean
  instruction: string
  lastReceipt: EditorCommandReceipt | null
  onAcknowledgedChange: (acknowledged: boolean) => void
  onApplyAgentPlan: () => void
  onApplyOperations: (operations: EditorLocalOperation[], instruction: string) => Promise<void>
  onInstructionChange: (instruction: string) => void
  onPlan: () => void
  onRequestPendingAction?: PendingActionRequestHandler
  onTabChange: (tab: EditorWorkbenchTab) => void
  proposal: EditorOperationProposal | null
  regionRef: RefObject<HTMLElement>
  selectedAssetId: string | null
  selection: EditorSelection | null
  snapshot: EditorCompositionSnapshot
  stale: boolean
  tab: EditorWorkbenchTab
}) {
  const changeTabFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const lastIndex = TABS.length - 1
    const nextIndex = event.key === 'ArrowRight'
      ? (index + 1) % TABS.length
      : event.key === 'ArrowLeft'
        ? (index - 1 + TABS.length) % TABS.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? lastIndex
            : null
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = TABS[nextIndex]
    onTabChange(nextTab.id)
    window.requestAnimationFrame(() => {
      document.getElementById(`editor-workbench-tab-${nextTab.id}`)?.focus()
    })
  }

  return (
    <aside
      aria-label="Inspector, Creative Agent, review and activity"
      className={styles.workbench}
      ref={regionRef}
      tabIndex={-1}
    >
      <div className={styles.workbenchTabs} role="tablist" aria-label="Editor context">
        {TABS.map((item, index) => (
          <button
            aria-controls="editor-workbench-panel"
            aria-selected={tab === item.id}
            className={tab === item.id ? styles.workbenchTabActive : undefined}
            id={`editor-workbench-tab-${item.id}`}
            key={item.id}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => changeTabFromKeyboard(event, index)}
            role="tab"
            tabIndex={tab === item.id ? 0 : -1}
            type="button"
          >
            <EditorIcon name={item.icon} size={15} />
            <span>{item.label}</span>
            {item.id === 'review' && snapshot.review.openComments > 0 && (
              <em>{snapshot.review.openComments}</em>
            )}
          </button>
        ))}
      </div>

      <div
        aria-labelledby={`editor-workbench-tab-${tab}`}
        className={styles.workbenchBody}
        id="editor-workbench-panel"
        role="tabpanel"
      >
        {tab === 'inspector' && (
          <InspectorPanel
            busy={busy}
            onApplyOperations={onApplyOperations}
            selectedAssetId={selectedAssetId}
            selection={selection}
            snapshot={snapshot}
          />
        )}
        {tab === 'agent' && (
          <CreativeAgentPanel
            acknowledged={acknowledged}
            actor={actor}
            busy={busy}
            currentVersion={snapshot.version}
            instruction={instruction}
            lastReceipt={lastReceipt}
            onAcknowledgedChange={onAcknowledgedChange}
            onApply={onApplyAgentPlan}
            onInstructionChange={onInstructionChange}
            onPlan={onPlan}
            onRequestPendingAction={onRequestPendingAction}
            proposal={proposal}
            stale={stale}
          />
        )}
        {tab === 'review' && <ReviewPanel actor={actor} snapshot={snapshot} />}
        {tab === 'activity' && <ActivityPanel snapshot={snapshot} />}
      </div>
    </aside>
  )
}

function InspectorPanel({
  busy,
  onApplyOperations,
  selectedAssetId,
  selection,
  snapshot,
}: {
  busy: boolean
  onApplyOperations: (operations: EditorLocalOperation[], instruction: string) => Promise<void>
  selectedAssetId: string | null
  selection: EditorSelection | null
  snapshot: EditorCompositionSnapshot
}) {
  const selected = selectedEditorClip(snapshot, selection)
  const inspectedAssetId = selected
    ? selected.clip.assetId
    : selectedAssetId
  const asset = snapshot.assets.find(
    (candidate) => candidate.assetId === inspectedAssetId,
  ) ?? null
  const [draft, setDraft] = useState<InspectorDraft>(() => draftForSelected(selected?.clip))

  useEffect(() => {
    setDraft(draftForSelected(selected?.clip))
  }, [selected?.clip])

  const textChanged = selected?.clip.kind === 'caption'
    && draft.text.trim()
    && draft.text.trim() !== (selected.clip.text ?? '')
  const timingChanged = Boolean(
    selected?.clip.kind === 'caption'
    && (draft.startSec !== selected.clip.startSec || draft.endSec !== selected.clip.endSec),
  )
  const trimChanged = Boolean(
    selected
    && (selected.clip.kind === 'video' || selected.clip.kind === 'image')
    && (
      draft.startSec !== selected.clip.startSec
      || draft.endSec !== selected.clip.endSec
      || draft.sourceStartSec !== selected.clip.sourceStartSec
      || draft.sourceEndSec !== selected.clip.sourceEndSec
    ),
  )
  const transformChanged = Boolean(
    selected
    && ['video', 'image', 'caption'].includes(selected.clip.kind)
    && (
      draft.x !== selected.clip.transform.x
      || draft.y !== selected.clip.transform.y
      || draft.scale !== selected.clip.transform.scale
      || draft.rotation !== selected.clip.transform.rotation
      || draft.opacity !== selected.clip.transform.opacity
    ),
  )
  const volumeChanged = Boolean(
    selected
    && ['video', 'voice', 'music', 'sfx'].includes(selected.clip.kind)
    && draft.volume !== selected.clip.volume,
  )

  const save = async () => {
    if (!selected) return
    const base = {
      id: '',
      effect: 'local_reversible' as const,
      estimatedCostBdt: 0 as const,
      requiredRole: 'creator' as const,
      target: { trackId: selected.track.id, clipId: selected.clip.id },
    }
    const operations: EditorLocalOperation[] = []
    if (textChanged) {
      operations.push({
        ...base,
        id: `manual-caption-text-v${snapshot.version}`,
        label: 'Update caption text',
        kind: 'caption.text.set',
        before: selected.clip.text ?? '',
        after: draft.text.trim(),
      })
    }
    if (timingChanged) {
      operations.push({
        ...base,
        id: `manual-caption-timing-v${snapshot.version}`,
        label: 'Update caption timing',
        kind: 'caption.timing.set',
        before: {
          startSec: selected.clip.startSec,
          endSec: selected.clip.endSec,
        },
        after: { startSec: draft.startSec, endSec: draft.endSec },
      })
    }
    if (trimChanged) {
      operations.push({
        ...base,
        id: `manual-clip-trim-v${snapshot.version}`,
        label: 'Trim selected clip',
        kind: 'clip.trim',
        before: {
          startSec: selected.clip.startSec,
          endSec: selected.clip.endSec,
          sourceStartSec: selected.clip.sourceStartSec,
          sourceEndSec: selected.clip.sourceEndSec,
        },
        after: {
          startSec: draft.startSec,
          endSec: draft.endSec,
          sourceStartSec: draft.sourceStartSec,
          sourceEndSec: draft.sourceEndSec,
        },
      })
    }
    if (transformChanged) {
      operations.push({
        ...base,
        id: `manual-transform-v${snapshot.version}`,
        label: 'Update selected transform',
        kind: 'node.transform.set',
        before: { ...selected.clip.transform },
        after: {
          x: draft.x,
          y: draft.y,
          scale: draft.scale,
          rotation: draft.rotation,
          opacity: draft.opacity,
        },
      })
    }
    if (volumeChanged) {
      operations.push({
        ...base,
        id: `manual-volume-v${snapshot.version}`,
        label: `Set ${selected.clip.kind} volume`,
        kind: 'track.volume.set',
        before: selected.clip.volume,
        after: draft.volume,
      })
    }
    if (operations.length > 0) {
      await onApplyOperations(operations, `Inspector update for ${selected.clip.id}`)
    }
  }

  if (!selected) {
    return (
      <div className={styles.inspectorEmpty}>
        <EditorIcon name="inspector" size={24} />
        <strong>Select a timeline clip or source.</strong>
        <p>The same selection will synchronize across canvas, timeline and Agent context.</p>
      </div>
    )
  }

  const hasChanges = Boolean(
    textChanged || timingChanged || trimChanged || transformChanged || volumeChanged,
  )

  return (
    <div className={styles.inspectorPanel}>
      <header className={styles.selectionCard}>
        <span className={styles.selectionThumb} data-kind={selected.clip.kind}>
          <EditorIcon
            name={
              selected.clip.kind === 'caption'
                ? 'caption'
                : selected.clip.kind === 'voice'
                  ? 'voice'
                  : selected.clip.kind === 'music'
                    ? 'music'
                    : selected.clip.kind === 'sfx'
                      ? 'sfx'
                      : selected.clip.kind === 'image'
                        ? 'image'
                        : 'video'
            }
            size={19}
          />
        </span>
        <div>
          <span>SELECTED · {selected.track.label}</span>
          <strong>{selected.clip.label}</strong>
          <small>{selected.clip.id} · {formatEditorTime(selected.clip.startSec)}–{formatEditorTime(selected.clip.endSec)}</small>
        </div>
        <span className={styles.selectionStatus} data-status={selected.clip.status}>
          {selected.clip.status.replace('_', ' ')}
        </span>
      </header>

      {selected.clip.kind === 'caption' && (
        <section className={styles.inspectorSection}>
          <header><strong>Caption</strong><span>local · reversible</span></header>
          <label className={styles.inspectorTextarea}>
            <span>Text</span>
            <textarea
              maxLength={500}
              onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
              rows={4}
              value={draft.text}
            />
          </label>
          <div className={styles.inspectorGrid}>
            <NumberField
              label="Start (s)"
              max={snapshot.canvas.durationSec}
              min={0}
              onChange={(startSec) => setDraft((current) => ({ ...current, startSec }))}
              value={draft.startSec}
            />
            <NumberField
              label="End (s)"
              max={snapshot.canvas.durationSec}
              min={0.1}
              onChange={(endSec) => setDraft((current) => ({ ...current, endSec }))}
              value={draft.endSec}
            />
          </div>
        </section>
      )}

      {(selected.clip.kind === 'video' || selected.clip.kind === 'image') && (
        <section className={styles.inspectorSection}>
          <header><strong>Clip trim</strong><span>source preserved</span></header>
          <div className={styles.inspectorGrid}>
            <NumberField
              label="Timeline in"
              max={snapshot.canvas.durationSec}
              min={0}
              onChange={(startSec) => setDraft((current) => ({ ...current, startSec }))}
              value={draft.startSec}
            />
            <NumberField
              label="Timeline out"
              max={snapshot.canvas.durationSec}
              min={0.2}
              onChange={(endSec) => setDraft((current) => ({ ...current, endSec }))}
              value={draft.endSec}
            />
            <NumberField
              label="Source in"
              min={0}
              onChange={(sourceStartSec) => setDraft((current) => ({ ...current, sourceStartSec }))}
              value={draft.sourceStartSec}
            />
            <NumberField
              label="Source out"
              min={0.2}
              onChange={(sourceEndSec) => setDraft((current) => ({ ...current, sourceEndSec }))}
              value={draft.sourceEndSec}
            />
          </div>
        </section>
      )}

      {['video', 'image', 'caption'].includes(selected.clip.kind) && (
        <section className={styles.inspectorSection}>
          <header><strong>Transform</strong><button onClick={() => setDraft((current) => ({
            ...current,
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            opacity: 1,
          }))} type="button">Reset</button></header>
          <div className={styles.inspectorGrid}>
            <NumberField label="X" max={2} min={-2} onChange={(x) => setDraft((current) => ({ ...current, x }))} value={draft.x} />
            <NumberField label="Y" max={2} min={-2} onChange={(y) => setDraft((current) => ({ ...current, y }))} value={draft.y} />
            <NumberField label="Scale" max={4} min={0.1} onChange={(scale) => setDraft((current) => ({ ...current, scale }))} value={draft.scale} />
            <NumberField label="Rotate" max={360} min={-360} onChange={(rotation) => setDraft((current) => ({ ...current, rotation }))} value={draft.rotation} />
          </div>
          <label className={styles.inspectorRange}>
            <span>Opacity <em>{Math.round(draft.opacity * 100)}%</em></span>
            <input
              max={1}
              min={0}
              onChange={(event) => setDraft((current) => ({ ...current, opacity: Number(event.target.value) }))}
              step={0.01}
              type="range"
              value={draft.opacity}
            />
          </label>
        </section>
      )}

      {['video', 'voice', 'music', 'sfx'].includes(selected.clip.kind) && (
        <section className={styles.inspectorSection}>
          <header><strong>Track volume</strong><span>{Math.round(draft.volume * 100)}%</span></header>
          <label className={styles.inspectorRange}>
            <span className={styles.srOnly}>Selected clip volume</span>
            <input
              max={1}
              min={0}
              onChange={(event) => setDraft((current) => ({ ...current, volume: Number(event.target.value) }))}
              step={0.01}
              type="range"
              value={draft.volume}
            />
          </label>
        </section>
      )}

      {asset && (
        <section className={styles.inspectorSection}>
          <header>
            <strong>Provenance & A+B truth</strong>
            <span className={styles.verifiedBadge}>
              <EditorIcon name="check" size={11} />
              {asset.artifact?.validation ?? asset.status}
            </span>
          </header>
          <dl className={styles.provenanceGrid}>
            <div><dt>Asset version</dt><dd>{asset.assetVersionId}</dd></div>
            <div><dt>Provider / model</dt><dd>{asset.provider ?? 'Not hydrated'} · {asset.engine ?? 'Not hydrated'}</dd></div>
            <div><dt>Requested</dt><dd>{asset.artifact?.requestedTier?.toUpperCase() ?? 'source'} · {asset.artifact?.requestedAspectRatio ?? 'native'}</dd></div>
            <div><dt>Delivered</dt><dd>{artifactDimensionLabel(asset.artifact) ?? 'Descriptor not hydrated'}</dd></div>
            <div><dt>Reference roles</dt><dd>{asset.referenceContract?.bindings.map((binding) => binding.role).join(' → ') ?? 'No provider reference'}</dd></div>
            <div><dt>QC</dt><dd>{asset.qcLabel ?? 'Not available'}</dd></div>
            <div><dt>Provider cost</dt><dd>{asset.costBdt === null ? 'Not hydrated' : `৳${asset.costBdt} recorded`}</dd></div>
            <div><dt>Local edit</dt><dd>৳0 · reversible</dd></div>
          </dl>
        </section>
      )}

      <footer className={styles.inspectorSave}>
        <span>
          <EditorIcon name="lock" size={12} />
          Expected composition v{snapshot.version}
        </span>
        <button disabled={busy || !hasChanges || selected.clip.locked} onClick={() => void save()} type="button">
          {busy ? 'Validating…' : 'Apply local edit'}
        </button>
      </footer>
    </div>
  )
}

function ReviewPanel({
  actor,
  snapshot,
}: {
  actor: EditorActor
  snapshot: EditorCompositionSnapshot
}) {
  const approvalStale = snapshot.review.approvedVersion !== null
    && snapshot.review.approvedVersion !== snapshot.version
  return (
    <div className={styles.reviewPanel}>
      <header>
        <span>VERSION REVIEW</span>
        <h3>{snapshot.review.state.replace('_', ' ')}</h3>
        <p>
          Current composition v{snapshot.version}
          {snapshot.review.approvedVersion
            ? ` · last approved v${snapshot.review.approvedVersion}`
            : ' · no approved version'}
        </p>
      </header>
      {approvalStale && (
        <div className={styles.reviewWarning} role="status">
          <EditorIcon name="warning" size={16} />
          <span>
            <strong>Approval invalidated by a newer version.</strong>
            Render, export and publish must pin a newly approved composition.
          </span>
        </div>
      )}
      <section className={styles.reviewRole}>
        <span>{actor.name.slice(0, 2).toUpperCase()}</span>
        <div>
          <strong>{actor.name}</strong>
          <small>{actor.role} · authenticated Studio role</small>
        </div>
        <em>{actor.role === 'owner' ? 'FINAL' : 'SCOPED'}</em>
      </section>
      <article className={styles.reviewComment}>
        <header><strong>Reviewer</strong><time>Open comment</time></header>
        <p>Bring the first caption forward, but keep the product code visible through the opening beat.</p>
        <span><EditorIcon name="caption" size={13} />00:01.2 · caption-primary</span>
      </article>
      <article className={styles.reviewComment}>
        <header><strong>Creative Agent</strong><time>Policy</time></header>
        <p>Local changes may be proposed here. Approval, render and publish remain separate lifecycle commands.</p>
        <span><EditorIcon name="lock" size={13} />No review mutation in this adapter</span>
      </article>
      <footer className={styles.reviewBoundary}>
        <button disabled type="button">Request review · Foundation/lifecycle hook</button>
        <p>Workstream E reads review state only and cannot approve or publish.</p>
      </footer>
    </div>
  )
}

function ActivityPanel({ snapshot }: { snapshot: EditorCompositionSnapshot }) {
  return (
    <div className={styles.activityPanel}>
      <header>
        <span>APPEND-ONLY ACTIVITY</span>
        <h3>Composition history</h3>
        <p>Audit IDs arrive from the command port after a committed version.</p>
      </header>
      <ol>
        {[...snapshot.activity].reverse().map((entry) => (
          <li key={entry.id}>
            <span className={styles.activityIcon} data-kind={entry.kind}>
              <EditorIcon
                name={
                  entry.kind === 'review'
                    ? 'review'
                    : entry.kind === 'undo' || entry.kind === 'rollback'
                      ? 'undo'
                      : entry.kind === 'redo'
                        ? 'redo'
                        : 'activity'
                }
                size={14}
              />
            </span>
            <div>
              <strong>{entry.summary}</strong>
              <small>{entry.actorName} · v{entry.version} · {new Date(entry.createdAt).toLocaleString('bn-BD')}</small>
              <code>{entry.id}</code>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function NumberField({
  label,
  max,
  min,
  onChange,
  value,
}: {
  label: string
  max?: number
  min?: number
  onChange: (value: number) => void
  value: number
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={0.1}
        type="number"
        value={value}
      />
    </label>
  )
}

function draftForSelected(
  clip: EditorClip | undefined,
): InspectorDraft {
  return {
    text: clip?.text ?? '',
    startSec: clip?.startSec ?? 0,
    endSec: clip?.endSec ?? 0,
    sourceStartSec: clip?.sourceStartSec ?? 0,
    sourceEndSec: clip?.sourceEndSec ?? 0,
    volume: clip?.volume ?? 1,
    x: clip?.transform.x ?? 0,
    y: clip?.transform.y ?? 0,
    scale: clip?.transform.scale ?? 1,
    rotation: clip?.transform.rotation ?? 0,
    opacity: clip?.transform.opacity ?? 1,
  }
}
