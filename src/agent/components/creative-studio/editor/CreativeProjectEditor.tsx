'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentProviderContext,
  AgentVoiceContext,
  CompositionCommandPort,
  EditorActor,
  EditorCommandReceipt,
  EditorCompositionScope,
  EditorCompositionSnapshot,
  EditorLocalOperation,
  EditorOperationProposal,
  OwnerPlanAcknowledgement,
} from '@/lib/creative-studio/editor-agent'
import {
  compileCreativeAgentInstruction,
  createOperationProposal,
} from '@/lib/creative-studio/editor-agent'
import { EditorIcon } from './EditorIcon'
import { EditorMediaPanel } from './EditorMediaPanel'
import { EditorStage } from './EditorStage'
import { EditorTimeline } from './EditorTimeline'
import { EditorWorkbench } from './EditorWorkbench'
import {
  activeVisualClip,
  defaultEditorSelection,
  formatEditorTime,
  selectedEditorClip,
} from './editor-utils'
import type {
  EditorFocusMode,
  EditorSelection,
  EditorTool,
  EditorWorkbenchTab,
  PendingActionRequestHandler,
} from './ui-types'
import styles from './ProjectEditor.module.css'

export type CreativeProjectEditorProps = {
  actor: EditorActor
  commandPort: CompositionCommandPort
  embedded?: boolean
  generationProvider?: AgentProviderContext | null
  initialWorkbenchTab?: EditorWorkbenchTab
  onExit?: () => void
  onRequestPendingAction?: PendingActionRequestHandler
  readOnly?: boolean
  readOnlyReason?: string
  scope: EditorCompositionScope
  voice?: AgentVoiceContext | null
}

export function CreativeProjectEditor({
  actor,
  commandPort,
  embedded = false,
  generationProvider = null,
  initialWorkbenchTab = 'inspector',
  onExit,
  onRequestPendingAction,
  readOnly = false,
  readOnlyReason,
  scope,
  voice = null,
}: CreativeProjectEditorProps) {
  const presentationReadOnly = readOnly || actor.role === 'reviewer'
  const [snapshot, setSnapshot] = useState<EditorCompositionSnapshot | null>(null)
  const [selection, setSelection] = useState<EditorSelection | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [activeTool, setActiveTool] = useState<EditorTool>('project')
  const [workbenchTab, setWorkbenchTab] = useState<EditorWorkbenchTab>(initialWorkbenchTab)
  const [focusMode, setFocusMode] = useState<EditorFocusMode>('stage')
  const [playheadSec, setPlayheadSec] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [timelineZoom, setTimelineZoom] = useState(40)
  const [instruction, setInstruction] = useState('')
  const [proposal, setProposal] = useState<EditorOperationProposal | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [lastReceipt, setLastReceipt] = useState<EditorCommandReceipt | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('Editor command port loading…')
  const stageRef = useRef<HTMLElement>(null)
  const timelineRef = useRef<HTMLElement>(null)
  const workbenchRef = useRef<HTMLElement>(null)
  const mediaRef = useRef<HTMLDivElement>(null)
  const portScope = useMemo<EditorCompositionScope>(() => ({
    brandProfileId: scope.brandProfileId,
    projectId: scope.projectId,
    compositionId: scope.compositionId,
  }), [
    scope.brandProfileId,
    scope.compositionId,
    scope.projectId,
  ])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const loaded = await commandPort.load(portScope)
      setSnapshot(loaded)
      const nextSelection = defaultEditorSelection(loaded)
      setSelection(nextSelection)
      const selected = nextSelection
        ? selectedEditorClip(loaded, nextSelection)
        : null
      setSelectedAssetId(selected?.clip.assetId ?? loaded.assets[0]?.assetId ?? null)
      setPlayheadSec(0)
      setNotice(
        presentationReadOnly
          ? readOnlyReason
            ?? `Composition v${loaded.version} loaded in ${actor.role} preview.`
          : `Composition v${loaded.version} loaded through the command port.`,
      )
    } catch (reason) {
      setError(commandMessage(reason))
      setNotice('Composition could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [
    actor.role,
    commandPort,
    portScope,
    presentationReadOnly,
    readOnlyReason,
  ])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!playing || !snapshot) return
    const timer = window.setInterval(() => {
      setPlayheadSec((current) => {
        const next = Math.round((current + 0.1) * 10) / 10
        if (next >= snapshot.canvas.durationSec) {
          setPlaying(false)
          return 0
        }
        return next
      })
    }, 100)
    return () => window.clearInterval(timer)
  }, [playing, snapshot])

  useEffect(() => {
    if (!window.matchMedia('(max-width: 767px)').matches) return
    const region = focusMode === 'stage'
      ? stageRef.current
      : focusMode === 'timeline'
        ? timelineRef.current
        : focusMode === 'workbench'
          ? workbenchRef.current
          : mediaRef.current
    window.requestAnimationFrame(() => region?.focus())
  }, [focusMode])

  const stalePlan = Boolean(
    proposal
    && snapshot
    && (
      proposal.expectedVersion !== snapshot.version
      || proposal.expectedConcurrencyToken !== snapshot.concurrencyToken
    ),
  )

  const currentSelected = useMemo(
    () => snapshot ? selectedEditorClip(snapshot, selection) : null,
    [selection, snapshot],
  )
  const selectClip = useCallback((next: EditorSelection) => {
    if (!snapshot) return
    const selected = selectedEditorClip(snapshot, next)
    setSelection(next)
    setSelectedAssetId(selected?.clip.assetId ?? null)
    setWorkbenchTab('inspector')
  }, [snapshot])

  const updateFromReceipt = useCallback(
    (receipt: EditorCommandReceipt, message: string) => {
      setSnapshot(receipt.snapshot)
      setLastReceipt(receipt)
      setAcknowledged(false)
      setPlaying(false)
      setPlayheadSec((current) => Math.min(current, receipt.snapshot.canvas.durationSec))
      setNotice(`${message} · ${receipt.auditId}`)
      setSelection((current) => {
        if (!current) return defaultEditorSelection(receipt.snapshot)
        return selectedEditorClip(receipt.snapshot, current)
          ? current
          : defaultEditorSelection(receipt.snapshot)
      })
    },
    [],
  )

  const applyOperations = useCallback(async (
    operations: EditorLocalOperation[],
    operationInstruction: string,
  ) => {
    if (!snapshot || operations.length === 0) return
    if (presentationReadOnly) {
      setNotice(readOnlyReason ?? 'This authenticated role is preview-only.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const localProposal = await createOperationProposal({
        origin: 'human',
        snapshot,
        actor,
        instruction: operationInstruction,
        normalizedInstruction: operationInstruction.trim().toLocaleLowerCase('bn-BD'),
        operations,
      })
      const receipt = await commandPort.applyLocal({
        proposal: localProposal,
        actor,
      })
      updateFromReceipt(receipt, 'Reversible local edit applied')
    } catch (reason) {
      setError(commandMessage(reason))
      setNotice('Local edit was rejected; composition stayed unchanged.')
    } finally {
      setBusy(false)
    }
  }, [
    actor,
    commandPort,
    presentationReadOnly,
    readOnlyReason,
    snapshot,
    updateFromReceipt,
  ])

  const buildPlan = useCallback(async () => {
    if (!snapshot || instruction.trim().length < 2) return
    setBusy(true)
    setError(null)
    try {
      const next = await compileCreativeAgentInstruction(instruction, {
        snapshot,
        actor,
        selectedTrackId: selection?.trackId ?? null,
        selectedClipId: selection?.clipId ?? null,
        playheadSec,
        firstBeatSec: 1.2,
        generationProvider,
        voice,
      })
      setProposal(next)
      setAcknowledged(false)
      setWorkbenchTab('agent')
      setFocusMode('workbench')
      setNotice(
        `Plan ${next.id} created for composition v${next.expectedVersion}; no operation ran.`,
      )
    } catch (reason) {
      setError(commandMessage(reason))
      setNotice('Instruction could not be compiled; composition stayed unchanged.')
    } finally {
      setBusy(false)
    }
  }, [
    actor,
    generationProvider,
    instruction,
    playheadSec,
    selection?.clipId,
    selection?.trackId,
    snapshot,
    voice,
  ])

  const applyAgentPlan = useCallback(async () => {
    if (!snapshot || !proposal) return
    if (presentationReadOnly) {
      setNotice(readOnlyReason ?? 'This authenticated role is preview-only.')
      return
    }
    if (stalePlan) {
      setAcknowledged(false)
      setNotice(`Composition is v${snapshot.version}; re-plan before apply.`)
      return
    }
    if (actor.role !== 'owner' || !acknowledged) {
      setNotice('The authenticated owner must acknowledge the exact fingerprint.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const acknowledgement: OwnerPlanAcknowledgement = {
        fingerprint: proposal.fingerprint,
        scope: proposal.scope,
        expectedVersion: proposal.expectedVersion,
        acknowledgedByUserId: actor.userId,
        acknowledgedByRole: 'owner',
        acknowledgedAt: new Date().toISOString(),
      }
      const receipt = await commandPort.applyLocal({
        proposal,
        acknowledgement,
        actor,
      })
      updateFromReceipt(
        receipt,
        `${receipt.operationIds.length} local ৳0 operation${receipt.operationIds.length === 1 ? '' : 's'} applied; ${receipt.pendingActionIds.length} pending action${receipt.pendingActionIds.length === 1 ? '' : 's'} not executed`,
      )
    } catch (reason) {
      setError(commandMessage(reason))
      setNotice('Plan apply was rejected; composition stayed unchanged.')
    } finally {
      setBusy(false)
    }
  }, [
    acknowledged,
    actor,
    commandPort,
    proposal,
    presentationReadOnly,
    readOnlyReason,
    snapshot,
    stalePlan,
    updateFromReceipt,
  ])

  const runHistory = useCallback(async (
    kind: 'undo' | 'redo' | 'rollback',
  ) => {
    if (!snapshot || busy) return
    if (presentationReadOnly) {
      setNotice(readOnlyReason ?? 'History commands are disabled in preview.')
      return
    }
    if (
      kind === 'rollback'
      && (
        !snapshot.latestAgentBatchId
        || !snapshot.canRollbackLatestAgentBatch
      )
    ) {
      setNotice('No Agent rollback point is available.')
      return
    }
    setBusy(true)
    setError(null)
    const request = {
      scope: snapshot.scope,
      expectedVersion: snapshot.version,
      expectedConcurrencyToken: snapshot.concurrencyToken,
      actor,
    }
    try {
      const receipt = kind === 'undo'
        ? await commandPort.undo(request)
        : kind === 'redo'
          ? await commandPort.redo(request)
          : await commandPort.rollback({
              ...request,
              batchId: snapshot.latestAgentBatchId!,
            })
      updateFromReceipt(
        receipt,
        `${kind[0].toUpperCase()}${kind.slice(1)} recorded as a new version`,
      )
    } catch (reason) {
      setError(commandMessage(reason))
      setNotice(`${kind} is unavailable; composition stayed unchanged.`)
    } finally {
      setBusy(false)
    }
  }, [
    actor,
    busy,
    commandPort,
    presentationReadOnly,
    readOnlyReason,
    snapshot,
    updateFromReceipt,
  ])

  const splitAtPlayhead = useCallback(async () => {
    if (!snapshot) return
    if (presentationReadOnly) {
      setNotice(readOnlyReason ?? 'Split is disabled in preview.')
      return
    }
    const selectedVisual = currentSelected
      && (currentSelected.clip.kind === 'video' || currentSelected.clip.kind === 'image')
      ? currentSelected
      : (() => {
          const clip = activeVisualClip(snapshot, playheadSec)
          if (!clip) return null
          const track = snapshot.tracks.find((candidate) => candidate.id === clip.trackId)
          if (!track) return null
          return { clip, track, index: track.clips.findIndex((candidate) => candidate.id === clip.id) }
        })()
    if (!selectedVisual) {
      setNotice('Select a visual clip before split.')
      return
    }
    if (
      playheadSec - selectedVisual.clip.startSec < 0.2
      || selectedVisual.clip.endSec - playheadSec < 0.2
    ) {
      setNotice('Move the playhead at least 0.2s inside the selected clip.')
      return
    }
    const splitToken = String(Math.round(playheadSec * 10) / 10).replace('.', '-')
    await applyOperations([
      {
        id: `manual-split-${selectedVisual.clip.id}-v${snapshot.version}`,
        label: `Split at ${formatEditorTime(playheadSec)}`,
        kind: 'clip.split',
        effect: 'local_reversible',
        estimatedCostBdt: 0,
        requiredRole: 'creator',
        target: {
          trackId: selectedVisual.track.id,
          clipId: selectedVisual.clip.id,
        },
        before: {
          clipId: selectedVisual.clip.id,
          startSec: selectedVisual.clip.startSec,
          endSec: selectedVisual.clip.endSec,
        },
        after: {
          leftClipId: selectedVisual.clip.id,
          rightClipId: `${selectedVisual.clip.id}-split-${splitToken}`,
          splitAtSec: Math.round(playheadSec * 10) / 10,
        },
      },
    ], `Split ${selectedVisual.clip.id} at ${playheadSec}`)
  }, [
    applyOperations,
    currentSelected,
    playheadSec,
    presentationReadOnly,
    readOnlyReason,
    snapshot,
  ])

  const moveSelectedClip = useCallback(async (direction: -1 | 1) => {
    if (!snapshot || !currentSelected) return
    if (presentationReadOnly) {
      setNotice(readOnlyReason ?? 'Timeline changes are disabled in preview.')
      return
    }
    const nextIndex = currentSelected.index + direction
    if (nextIndex < 0 || nextIndex >= currentSelected.track.clips.length) return
    await applyOperations([
      {
        id: `manual-move-${currentSelected.clip.id}-v${snapshot.version}`,
        label: direction < 0 ? 'Move clip earlier' : 'Move clip later',
        kind: 'clip.move',
        effect: 'local_reversible',
        estimatedCostBdt: 0,
        requiredRole: 'creator',
        target: {
          trackId: currentSelected.track.id,
          clipId: currentSelected.clip.id,
        },
        before: { index: currentSelected.index },
        after: { index: nextIndex },
      },
    ], `Move ${currentSelected.clip.id} to index ${nextIndex}`)
  }, [
    applyOperations,
    currentSelected,
    presentationReadOnly,
    readOnlyReason,
    snapshot,
  ])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const editingText = target instanceof HTMLElement
        && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
      const interactive = target instanceof HTMLElement
        && Boolean(target.closest('button, a, input, textarea, select, summary, [contenteditable="true"]'))
      if (
        (event.metaKey || event.ctrlKey)
        && event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        setActiveTool('media')
        window.requestAnimationFrame(() => {
          document.getElementById('studio-editor-media-search')?.focus()
        })
        return
      }
      if (editingText) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (!presentationReadOnly) {
          void runHistory(event.shiftKey ? 'redo' : 'undo')
        }
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        if (!presentationReadOnly) void runHistory('redo')
        return
      }
      if (interactive) return
      if (event.code === 'Space') {
        event.preventDefault()
        setPlaying((current) => !current)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setPlayheadSec((current) => Math.max(0, Math.round((current - (event.shiftKey ? 1 : 0.1)) * 10) / 10))
      } else if (event.key === 'ArrowRight' && snapshot) {
        event.preventDefault()
        setPlayheadSec((current) => Math.min(snapshot.canvas.durationSec, Math.round((current + (event.shiftKey ? 1 : 0.1)) * 10) / 10))
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!presentationReadOnly) void splitAtPlayhead()
      } else if (event.key === '1') {
        setFocusMode('stage')
      } else if (event.key === '2') {
        setFocusMode('timeline')
      } else if (event.key === '3') {
        setFocusMode('media')
      } else if (event.key === '4') {
        setFocusMode('workbench')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [presentationReadOnly, runHistory, snapshot, splitAtPlayhead])

  if (loading) return <EditorLoading embedded={embedded} />
  if (!snapshot || error && !snapshot) {
    return (
      <section className={styles.editorFatal} role="alert">
        <EditorIcon name="warning" size={26} />
        <h1>Composition Editor could not open.</h1>
        <p>{error ?? 'The Foundation command port returned no composition.'}</p>
        <button onClick={() => void load()} type="button">Retry load</button>
        {onExit && <button onClick={onExit} type="button">Back to Creative Studio</button>}
      </section>
    )
  }

  return (
    <section
      aria-label={`Creative Studio Project Editor for ${snapshot.name}`}
      className={styles.editorShell}
      data-embedded={embedded ? 'true' : undefined}
      data-focus-mode={focusMode}
      data-readonly={presentationReadOnly ? 'true' : undefined}
    >
      <a className={styles.skipLink} href="#studio-editor-stage">Skip to canvas</a>
      <a className={styles.skipLink} href="#studio-editor-timeline">Skip to timeline</a>

      <header className={styles.editorTopbar}>
        <div className={styles.projectIdentity}>
          <button
            aria-label="Return to Creative Studio"
            disabled={!onExit}
            onClick={onExit}
            type="button"
          >
            <EditorIcon name="arrow-left" size={18} />
          </button>
          <span className={styles.almaMark}>A</span>
          <div>
            <span>{snapshot.brandName} / {snapshot.projectName}</span>
            <strong>{snapshot.name}</strong>
          </div>
          <button aria-label="Project menu unavailable in editor adapter" disabled type="button">
            <EditorIcon name="chevron-down" size={14} />
          </button>
        </div>

        <div className={styles.versionControls}>
          <span className={styles.savedState}>
            <EditorIcon name="check" size={12} />
            Port synced
          </span>
          <span className={styles.versionPill}>v{snapshot.version}</span>
          <button
            aria-keyshortcuts="Meta+Z Control+Z"
            aria-label="Undo latest local operation"
            disabled={presentationReadOnly || busy || !snapshot.canUndo}
            onClick={() => void runHistory('undo')}
            type="button"
          >
            <EditorIcon name="undo" size={16} />
          </button>
          <button
            aria-keyshortcuts="Meta+Shift+Z Control+Y"
            aria-label="Redo latest local operation"
            disabled={presentationReadOnly || busy || !snapshot.canRedo}
            onClick={() => void runHistory('redo')}
            type="button"
          >
            <EditorIcon name="redo" size={16} />
          </button>
          <button
            aria-label="Rollback latest Agent batch"
            disabled={
              presentationReadOnly
              || busy
              || !snapshot.latestAgentBatchId
              || !snapshot.canRollbackLatestAgentBatch
            }
            onClick={() => void runHistory('rollback')}
            type="button"
          >
            <EditorIcon name="activity" size={16} />
            Rollback
          </button>
        </div>

        <div className={styles.editorBoundaries}>
          <button onClick={() => {
            setWorkbenchTab('review')
            setFocusMode('workbench')
          }} type="button">
            <EditorIcon name="review" size={15} />
            Review
            <span>
              {snapshot.hydration?.review === 'hydrated'
                ? snapshot.review.openComments
                : '—'}
            </span>
          </button>
          <button aria-describedby="editor-export-boundary" disabled type="button">
            Export
          </button>
          <span className={styles.srOnly} id="editor-export-boundary">
            Export is a separate render action and is unavailable through the local command port.
          </span>
        </div>
      </header>

      <div className={styles.trustBar}>
        <span>
          <EditorIcon name="lock" size={11} />
          {snapshot.brandName} strict isolation
        </span>
        <span>{snapshot.productCode ?? 'No ERP product'} · {snapshot.recipeName ?? 'No recipe'} {snapshot.recipeVersion ? `v${snapshot.recipeVersion}` : ''}</span>
        <span>
          <EditorIcon name="check" size={11} />
          {presentationReadOnly
            ? `${actor.role} preview · local apply disabled`
            : 'Local apply: reversible ৳0 only'}
        </span>
        <span>
          Provider · voice · render · publish separated
        </span>
      </div>

      <div className={styles.editorWorkspace}>
        <div className={styles.mediaFocusRegion} ref={mediaRef} tabIndex={-1}>
          <EditorMediaPanel
            activeTool={activeTool}
            onSelect={selectClip}
            onSelectAsset={setSelectedAssetId}
            onToolChange={setActiveTool}
            selectedAssetId={selectedAssetId}
            selection={selection}
            snapshot={snapshot}
          />
        </div>

        <main className={styles.editorMain}>
          <EditorStage
            onPlayToggle={() => setPlaying((current) => !current)}
            onSeek={setPlayheadSec}
            onSelect={selectClip}
            onSplit={() => void splitAtPlayhead()}
            playing={playing}
            playheadSec={playheadSec}
            regionRef={stageRef}
            selection={selection}
            snapshot={snapshot}
            readOnly={presentationReadOnly}
          />
          <EditorTimeline
            onMoveClip={(direction) => void moveSelectedClip(direction)}
            onSelect={selectClip}
            onSplit={() => void splitAtPlayhead()}
            onZoomChange={setTimelineZoom}
            playheadSec={playheadSec}
            regionRef={timelineRef}
            selection={selection}
            snapshot={snapshot}
            readOnly={presentationReadOnly}
            zoom={timelineZoom}
          />
        </main>

        <EditorWorkbench
          acknowledged={acknowledged}
          actor={actor}
          busy={busy}
          instruction={instruction}
          lastReceipt={lastReceipt}
          onAcknowledgedChange={setAcknowledged}
          onApplyAgentPlan={() => void applyAgentPlan()}
          onApplyOperations={applyOperations}
          onInstructionChange={setInstruction}
          onPlan={() => void buildPlan()}
          onRequestPendingAction={
            onRequestPendingAction
              ? (action) => {
                  setNotice(`${action.label} remains pending in its separate confirmation flow.`)
                  onRequestPendingAction(action)
                }
              : undefined
          }
          onTabChange={setWorkbenchTab}
          proposal={proposal}
          readOnly={presentationReadOnly}
          regionRef={workbenchRef}
          selectedAssetId={selectedAssetId}
          selection={selection}
          snapshot={snapshot}
          stale={stalePlan}
          tab={workbenchTab}
        />
      </div>

      <nav className={styles.focusNavigation} aria-label="Responsive editor focus mode">
        {([
          ['stage', 'play', 'Stage'],
          ['timeline', 'timeline', 'Timeline'],
          ['media', 'assets', 'Media'],
          ['workbench', 'inspector', workbenchTab === 'agent' ? 'Agent' : 'Context'],
        ] as const).map(([mode, icon, label], index) => (
          <button
            aria-keyshortcuts={String(index + 1)}
            aria-pressed={focusMode === mode}
            className={focusMode === mode ? styles.focusNavigationActive : undefined}
            key={mode}
            onClick={() => setFocusMode(mode)}
            type="button"
          >
            <EditorIcon name={icon} size={17} />
            {label}
          </button>
        ))}
      </nav>

      <details className={styles.keyboardHelp}>
        <summary>Keyboard</summary>
        <dl>
          <div><dt>Space</dt><dd>Play / pause</dd></div>
          <div><dt>← / →</dt><dd>Move playhead · Shift = 1s</dd></div>
          <div><dt>S</dt><dd>{presentationReadOnly ? 'Split disabled in preview' : 'Split selected visual clip'}</dd></div>
          <div><dt>⌘/Ctrl K</dt><dd>Focus media search</dd></div>
          <div><dt>⌘/Ctrl Z</dt><dd>Undo · Shift/Y = redo</dd></div>
          <div><dt>1–4</dt><dd>Responsive focus mode</dd></div>
        </dl>
      </details>

      <div className={styles.editorNotice} role="status" aria-live="polite">
        <span />
        <p>{notice}</p>
        {error && <strong role="alert">{error}</strong>}
        <button
          aria-label="Dismiss editor status"
          onClick={() => {
            setNotice('')
            setError(null)
          }}
          type="button"
        >
          <EditorIcon name="close" size={13} />
        </button>
      </div>
    </section>
  )
}

function EditorLoading({ embedded }: { embedded: boolean }) {
  return (
    <section
      aria-label="Project Editor loading"
      className={styles.editorLoading}
      data-embedded={embedded ? 'true' : undefined}
    >
      <div className={styles.loadingTopbar} />
      <div>
        <span />
        <main />
        <aside />
      </div>
      <p>Loading versioned composition through the command port…</p>
    </section>
  )
}

function commandMessage(reason: unknown): string {
  if (reason instanceof Error) {
    const messages: Record<string, string> = {
      approval_required: 'Exact owner acknowledgement is required.',
      fingerprint_mismatch: 'Plan payload, provider, target or cost changed; re-plan.',
      scope_mismatch: 'Brand, project or composition scope does not match.',
      stale_version: 'Composition version changed; reload or re-plan.',
      stale_target: 'A target clip changed or no longer exists; re-plan.',
      role_forbidden: 'The authenticated Studio role cannot perform this command.',
      unsafe_operation: 'Only reversible ৳0 operations can use local apply.',
      clarification_required: 'A deterministic target or value is still missing.',
      history_unavailable: 'No matching undo, redo or rollback point is available.',
      network_unavailable: 'The Foundation service is offline; no edit was applied.',
      invalid_foundation_response: 'The Foundation response failed contract validation.',
      unsupported_foundation_mapping: 'This composition shape is not safely representable in the editor.',
      idempotency_conflict: 'The Foundation rejected a reused command key with different content.',
      foundation_unavailable: 'The Foundation composition service is unavailable.',
    }
    return messages[reason.message] ?? messages[reason.name] ?? reason.message
  }
  return 'The editor command could not be completed.'
}
