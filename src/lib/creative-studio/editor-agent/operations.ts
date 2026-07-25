import {
  EDITOR_AGENT_CONTRACT_VERSION,
  type EditorActor,
  type EditorClip,
  type EditorCompositionSnapshot,
  type EditorLocalOperation,
  type EditorOperationProposal,
  type EditorOperationTarget,
  type EditorPendingAction,
  type EditorPlanWarning,
  type EditorTrack,
} from '@/lib/creative-studio/editor-agent/contracts'
import {
  computeProposalFingerprint,
  shortPlanFingerprint,
  stableStringify,
} from '@/lib/creative-studio/editor-agent/fingerprint'

const round = (value: number, precision = 3) => {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export function cloneEditorSnapshot(
  snapshot: EditorCompositionSnapshot,
): EditorCompositionSnapshot {
  return structuredClone(snapshot)
}

export function findEditorTrack(
  snapshot: EditorCompositionSnapshot,
  trackId: string,
): EditorTrack | null {
  return snapshot.tracks.find((track) => track.id === trackId) ?? null
}

export function findEditorClip(
  snapshot: EditorCompositionSnapshot,
  target: EditorOperationTarget,
): { track: EditorTrack; clip: EditorClip; index: number } | null {
  if (!target.clipId) return null
  const track = findEditorTrack(snapshot, target.trackId)
  if (!track) return null
  const index = track.clips.findIndex((clip) => clip.id === target.clipId)
  if (index < 0) return null
  return { track, clip: track.clips[index], index }
}

export function operationId(
  index: number,
  kind: EditorLocalOperation['kind'],
  target: EditorOperationTarget,
): string {
  const clean = `${kind}-${target.trackId}-${target.clipId ?? 'track'}`
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return `op-${String(index + 1).padStart(2, '0')}-${clean}`.slice(0, 96)
}

export async function createOperationProposal(input: {
  origin: EditorOperationProposal['origin']
  snapshot: EditorCompositionSnapshot
  actor: EditorActor
  instruction: string
  normalizedInstruction: string
  operations: EditorLocalOperation[]
  pendingActions?: EditorPendingAction[]
  warnings?: EditorPlanWarning[]
  requiresClarification?: boolean
}): Promise<EditorOperationProposal> {
  const pendingActions = input.pendingActions ?? []
  const totalPendingCostBdt = pendingActions.reduce(
    (total, action) => total + Math.max(0, Math.round(action.estimatedCostBdt)),
    0,
  )
  const proposalWithoutFingerprint: Omit<EditorOperationProposal, 'fingerprint'> = {
    contractVersion: EDITOR_AGENT_CONTRACT_VERSION,
    id: 'pending-fingerprint',
    origin: input.origin,
    scope: { ...input.snapshot.scope },
    expectedVersion: input.snapshot.version,
    expectedConcurrencyToken: input.snapshot.concurrencyToken,
    actorRoleAtPlan: input.actor.role,
    instruction: input.instruction,
    normalizedInstruction: input.normalizedInstruction,
    operations: input.operations,
    pendingActions,
    warnings: input.warnings ?? [],
    requiresClarification: input.requiresClarification ?? false,
    totalLocalCostBdt: 0,
    totalPendingCostBdt,
  }
  const fingerprint = await computeProposalFingerprint(proposalWithoutFingerprint)
  return {
    ...proposalWithoutFingerprint,
    id: `proposal-${shortPlanFingerprint(fingerprint).toLowerCase()}`,
    fingerprint,
  }
}

function assertClipKind(clip: EditorClip, allowed: EditorClip['kind'][]): void {
  if (!allowed.includes(clip.kind)) throw new Error('operation_target_kind_invalid')
}

function assertBefore(actual: unknown, expected: unknown): void {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error('operation_before_mismatch')
  }
}

function replaceClip(
  snapshot: EditorCompositionSnapshot,
  target: EditorOperationTarget,
  update: (clip: EditorClip, index: number, track: EditorTrack) => EditorClip[],
): void {
  const found = findEditorClip(snapshot, target)
  if (!found) throw new Error('operation_target_missing')
  const replacements = update(found.clip, found.index, found.track)
  found.track.clips.splice(found.index, 1, ...replacements)
}

export function applyEditorOperation(
  snapshot: EditorCompositionSnapshot,
  operation: EditorLocalOperation,
): void {
  if (operation.effect !== 'local_reversible' || operation.estimatedCostBdt !== 0) {
    throw new Error('unsafe_operation')
  }

  if (operation.kind === 'caption.text.set') {
    replaceClip(snapshot, operation.target, (clip) => {
      assertClipKind(clip, ['caption'])
      assertBefore(clip.text ?? '', operation.before)
      const text = operation.after.trim().slice(0, 500)
      if (!text) throw new Error('caption_text_required')
      return [{ ...clip, text, label: text.slice(0, 72) }]
    })
    return
  }

  if (operation.kind === 'caption.timing.set') {
    replaceClip(snapshot, operation.target, (clip) => {
      assertClipKind(clip, ['caption'])
      assertBefore(
        { startSec: clip.startSec, endSec: clip.endSec },
        operation.before,
      )
      const startSec = round(clamp(operation.after.startSec, 0, snapshot.canvas.durationSec))
      const endSec = round(clamp(operation.after.endSec, 0, snapshot.canvas.durationSec))
      if (endSec - startSec < 0.1) throw new Error('caption_timing_invalid')
      return [{ ...clip, startSec, endSec }]
    })
    return
  }

  if (operation.kind === 'clip.trim') {
    replaceClip(snapshot, operation.target, (clip) => {
      assertClipKind(clip, ['video', 'image'])
      assertBefore(
        {
          startSec: clip.startSec,
          endSec: clip.endSec,
          sourceStartSec: clip.sourceStartSec,
          sourceEndSec: clip.sourceEndSec,
        },
        operation.before,
      )
      const next = {
        startSec: round(clamp(operation.after.startSec, 0, snapshot.canvas.durationSec)),
        endSec: round(clamp(operation.after.endSec, 0, snapshot.canvas.durationSec)),
        sourceStartSec: round(Math.max(0, operation.after.sourceStartSec)),
        sourceEndSec: round(Math.max(0, operation.after.sourceEndSec)),
      }
      if (next.endSec - next.startSec < 0.2) throw new Error('clip_too_short')
      if (next.sourceEndSec - next.sourceStartSec < 0.2) {
        throw new Error('source_range_too_short')
      }
      return [{ ...clip, ...next }]
    })
    return
  }

  if (operation.kind === 'clip.split') {
    replaceClip(snapshot, operation.target, (clip) => {
      assertClipKind(clip, ['video', 'image'])
      assertBefore(
        { clipId: clip.id, startSec: clip.startSec, endSec: clip.endSec },
        operation.before,
      )
      const splitAtSec = round(operation.after.splitAtSec)
      if (
        splitAtSec - clip.startSec < 0.2
        || clip.endSec - splitAtSec < 0.2
      ) {
        throw new Error('split_outside_clip')
      }
      const sourceSplitSec = round(
        clip.sourceStartSec + (splitAtSec - clip.startSec),
      )
      const left: EditorClip = {
        ...clip,
        id: operation.after.leftClipId,
        endSec: splitAtSec,
        sourceEndSec: sourceSplitSec,
        label: `${clip.label} · A`,
      }
      const right: EditorClip = {
        ...clip,
        id: operation.after.rightClipId,
        startSec: splitAtSec,
        sourceStartSec: sourceSplitSec,
        label: `${clip.label} · B`,
      }
      if (left.id === right.id) throw new Error('duplicate_split_clip_id')
      return [left, right]
    })
    return
  }

  if (operation.kind === 'clip.move') {
    const found = findEditorClip(snapshot, operation.target)
    if (!found) throw new Error('operation_target_missing')
    assertBefore({ index: found.index }, operation.before)
    const nextIndex = Math.round(
      clamp(operation.after.index, 0, found.track.clips.length - 1),
    )
    const [clip] = found.track.clips.splice(found.index, 1)
    found.track.clips.splice(nextIndex, 0, clip)
    return
  }

  if (operation.kind === 'node.transform.set') {
    replaceClip(snapshot, operation.target, (clip) => {
      assertClipKind(clip, ['video', 'image', 'caption'])
      assertBefore(clip.transform, operation.before)
      const after = operation.after
      const transform = {
        x: round(clamp(after.x, -2, 2)),
        y: round(clamp(after.y, -2, 2)),
        scale: round(clamp(after.scale, 0.1, 4)),
        rotation: round(clamp(after.rotation, -360, 360)),
        opacity: round(clamp(after.opacity, 0, 1)),
      }
      return [{ ...clip, transform }]
    })
    return
  }

  if (operation.kind === 'track.volume.set') {
    replaceClip(snapshot, operation.target, (clip) => {
      assertClipKind(clip, ['video', 'voice', 'music', 'sfx'])
      assertBefore(clip.volume, operation.before)
      return [{ ...clip, volume: round(clamp(operation.after, 0, 1)) }]
    })
    return
  }

  const exhaustive: never = operation
  throw new Error(`unsupported_operation:${String(exhaustive)}`)
}

export function applyEditorOperations(
  snapshot: EditorCompositionSnapshot,
  operations: EditorLocalOperation[],
): EditorCompositionSnapshot {
  const next = cloneEditorSnapshot(snapshot)
  for (const operation of operations) applyEditorOperation(next, operation)
  return next
}

export function inverseEditorOperation(
  operation: EditorLocalOperation,
): EditorLocalOperation | null {
  if (operation.kind === 'clip.split') return null
  if (operation.kind === 'caption.text.set') {
    return { ...operation, before: operation.after, after: operation.before }
  }
  if (operation.kind === 'caption.timing.set') {
    return { ...operation, before: operation.after, after: operation.before }
  }
  if (operation.kind === 'clip.trim') {
    return { ...operation, before: operation.after, after: operation.before }
  }
  if (operation.kind === 'clip.move') {
    return { ...operation, before: operation.after, after: operation.before }
  }
  if (operation.kind === 'node.transform.set') {
    return { ...operation, before: operation.after, after: operation.before }
  }
  if (operation.kind === 'track.volume.set') {
    return { ...operation, before: operation.after, after: operation.before }
  }
  const exhaustive: never = operation
  return exhaustive
}
