import type {
  CreativeCompositionClip,
  CreativeCompositionDocument,
  CreativeCompositionTrack,
} from '@/lib/creative-studio/composition-document'
import type { CreativeEditOperationInput } from '@/lib/creative-studio/composition-operations'
import type {
  EditorLocalOperation,
  EditorOperationTarget,
  EditorTransform,
} from '@/lib/creative-studio/editor-agent/contracts'
import { unsupportedFoundationMapping } from '@/lib/creative-studio/editor-agent/foundation-errors'

type FoundationOperationMeta = {
  selection: {
    nodeIds: string[]
    trackIds: string[]
    clipIds: string[]
  }
  timeRange?: {
    startMs: number
    endMs: number
  }
}

export type CompiledFoundationEditorOperations = {
  operations: CreativeEditOperationInput[]
  document: CreativeCompositionDocument
}

function cloneDocument(
  document: CreativeCompositionDocument,
): CreativeCompositionDocument {
  return structuredClone(document)
}

function toMs(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    return unsupportedFoundationMapping('non_finite_editor_time', { label })
  }
  const milliseconds = Math.round(value * 1_000)
  if (milliseconds < 0 || milliseconds > 86_400_000) {
    return unsupportedFoundationMapping('editor_time_out_of_range', {
      label,
      milliseconds,
    })
  }
  return milliseconds
}

function stableId(value: string, label: string): string {
  if (
    value.length < 1
    || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    return unsupportedFoundationMapping('invalid_foundation_stable_id', {
      label,
    })
  }
  return value
}

function target(
  document: CreativeCompositionDocument,
  operationTarget: EditorOperationTarget,
): {
  track: CreativeCompositionTrack
  trackIndex: number
  clip: CreativeCompositionClip
  clipIndex: number
} {
  const trackIndex = document.tracks.findIndex(
    (candidate) => candidate.id === operationTarget.trackId,
  )
  if (trackIndex < 0) {
    return unsupportedFoundationMapping('operation_track_missing', {
      trackId: operationTarget.trackId,
    })
  }
  const track = document.tracks[trackIndex]
  const clipIndex = track.clips.findIndex(
    (candidate) => candidate.id === operationTarget.clipId,
  )
  if (clipIndex < 0) {
    return unsupportedFoundationMapping('operation_clip_missing', {
      trackId: track.id,
      clipId: operationTarget.clipId,
    })
  }
  return { track, trackIndex, clip: track.clips[clipIndex], clipIndex }
}

function meta(
  track: CreativeCompositionTrack,
  clip: CreativeCompositionClip,
  timeRange?: { startMs: number; endMs: number },
): FoundationOperationMeta {
  return {
    selection: {
      nodeIds: [clip.nodeId],
      trackIds: [track.id],
      clipIds: [clip.id],
    },
    ...(timeRange ? { timeRange } : {}),
  }
}

function replaceClip(
  output: CreativeEditOperationInput[],
  document: CreativeCompositionDocument,
  trackIndex: number,
  clipIndex: number,
  clip: CreativeCompositionClip,
  operationMeta: FoundationOperationMeta,
): void {
  const track = document.tracks[trackIndex]
  const previous = track.clips[clipIndex]
  track.clips[clipIndex] = clip
  output.push({
    type: 'clip.replace',
    trackId: track.id,
    clipId: previous.id,
    clip: structuredClone(clip),
    ...operationMeta,
  })
}

function editorScale(
  transform: NonNullable<CreativeCompositionClip['transform']>,
): number {
  return Math.sqrt(transform.width * transform.height)
}

function assertTransformRepresentable(transform: EditorTransform): void {
  if (
    !Number.isFinite(transform.x)
    || !Number.isFinite(transform.y)
    || !Number.isFinite(transform.scale)
    || !Number.isFinite(transform.rotation)
    || !Number.isFinite(transform.opacity)
    || transform.x < -2
    || transform.x > 2
    || transform.y < -2
    || transform.y > 2
    || transform.scale < 0.1
    || transform.scale > 4
    || transform.rotation < -360
    || transform.rotation > 360
    || transform.opacity < 0
    || transform.opacity > 1
  ) {
    unsupportedFoundationMapping('editor_transform_out_of_range')
  }
}

function foundationVolume(value: number): NonNullable<CreativeCompositionClip['volume']> {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return unsupportedFoundationMapping('editor_volume_out_of_range')
  }
  if (value === 0) return { gainDb: -96, muted: true }
  return {
    gainDb: Math.max(-96, Math.min(0, Math.round(20 * Math.log10(value) * 1_000_000) / 1_000_000)),
    muted: false,
  }
}

function compileOne(
  document: CreativeCompositionDocument,
  operation: EditorLocalOperation,
): CreativeEditOperationInput[] {
  const output: CreativeEditOperationInput[] = []
  const found = target(document, operation.target)
  const { track, trackIndex, clip, clipIndex } = found
  const nodeIndex = document.nodes.findIndex((node) => node.id === clip.nodeId)
  if (nodeIndex < 0) {
    return unsupportedFoundationMapping('operation_node_missing', {
      nodeId: clip.nodeId,
    })
  }
  const node = document.nodes[nodeIndex]

  if (operation.kind === 'caption.text.set') {
    if (
      (node.kind !== 'caption' && node.kind !== 'text')
      || (track.kind !== 'caption' && track.kind !== 'text')
    ) {
      return unsupportedFoundationMapping('caption_text_target_invalid')
    }
    const referenceCount = document.tracks.reduce(
      (count, candidate) => count
        + candidate.clips.filter((candidateClip) => candidateClip.nodeId === node.id).length,
      0,
    )
    if (referenceCount !== 1) {
      return unsupportedFoundationMapping('shared_caption_node_not_supported', {
        nodeId: node.id,
        referenceCount,
      })
    }
    const content = operation.after.trim().slice(0, 500)
    const replacement = {
      ...node,
      name: content.slice(0, 72),
      content,
    }
    if (!replacement.content) {
      return unsupportedFoundationMapping('caption_text_required')
    }
    document.nodes[nodeIndex] = replacement
    output.push({
      type: 'node.replace',
      nodeId: node.id,
      node: structuredClone(replacement),
      ...meta(track, clip),
    })
    return output
  }

  if (operation.kind === 'caption.timing.set') {
    if (node.kind !== 'caption' && node.kind !== 'text') {
      return unsupportedFoundationMapping('caption_timing_target_invalid')
    }
    const startMs = toMs(operation.after.startSec, 'caption.start')
    const endMs = toMs(operation.after.endSec, 'caption.end')
    if (endMs <= startMs) {
      return unsupportedFoundationMapping('caption_timing_invalid')
    }
    replaceClip(
      output,
      document,
      trackIndex,
      clipIndex,
      { ...clip, startMs, durationMs: endMs - startMs },
      meta(track, clip, { startMs, endMs }),
    )
    return output
  }

  if (operation.kind === 'clip.trim') {
    if (node.kind !== 'video' && node.kind !== 'image') {
      return unsupportedFoundationMapping('trim_target_invalid')
    }
    const startMs = toMs(operation.after.startSec, 'trim.start')
    const endMs = toMs(operation.after.endSec, 'trim.end')
    const sourceStartMs = toMs(operation.after.sourceStartSec, 'trim.sourceStart')
    const sourceEndMs = toMs(operation.after.sourceEndSec, 'trim.sourceEnd')
    if (
      endMs <= startMs
      || sourceEndMs <= sourceStartMs
      || endMs - startMs !== sourceEndMs - sourceStartMs
    ) {
      return unsupportedFoundationMapping('variable_rate_trim_not_supported')
    }
    replaceClip(
      output,
      document,
      trackIndex,
      clipIndex,
      {
        ...clip,
        startMs,
        durationMs: endMs - startMs,
        sourceOffsetMs: sourceStartMs,
      },
      meta(track, clip, { startMs, endMs }),
    )
    return output
  }

  if (operation.kind === 'clip.split') {
    if (node.kind !== 'video' && node.kind !== 'image') {
      return unsupportedFoundationMapping('split_target_invalid')
    }
    const splitAtMs = toMs(operation.after.splitAtSec, 'split.at')
    const clipEndMs = clip.startMs + clip.durationMs
    if (splitAtMs <= clip.startMs || splitAtMs >= clipEndMs) {
      return unsupportedFoundationMapping('split_outside_clip')
    }
    const leftId = stableId(operation.after.leftClipId, 'split.leftClipId')
    const rightId = stableId(operation.after.rightClipId, 'split.rightClipId')
    if (
      leftId === rightId
      || document.tracks.some((candidate) => candidate.clips.some(
        (candidateClip) => (
          candidateClip.id !== clip.id
          && (candidateClip.id === leftId || candidateClip.id === rightId)
        ),
      ))
    ) {
      return unsupportedFoundationMapping('duplicate_split_clip_id')
    }
    const leftDurationMs = splitAtMs - clip.startMs
    const left: CreativeCompositionClip = {
      ...clip,
      id: leftId,
      durationMs: leftDurationMs,
    }
    const right: CreativeCompositionClip = {
      ...clip,
      id: rightId,
      startMs: splitAtMs,
      durationMs: clipEndMs - splitAtMs,
      sourceOffsetMs: clip.sourceOffsetMs + leftDurationMs,
    }
    const operationMeta = meta(track, clip, {
      startMs: clip.startMs,
      endMs: clipEndMs,
    })
    track.clips.splice(clipIndex, 1)
    output.push({
      type: 'clip.remove',
      trackId: track.id,
      clipId: clip.id,
      ...operationMeta,
    })
    track.clips.splice(clipIndex, 0, left)
    output.push({
      type: 'clip.insert',
      trackId: track.id,
      clip: structuredClone(left),
      index: clipIndex,
      ...operationMeta,
    })
    track.clips.splice(clipIndex + 1, 0, right)
    output.push({
      type: 'clip.insert',
      trackId: track.id,
      clip: structuredClone(right),
      index: clipIndex + 1,
      ...operationMeta,
    })
    return output
  }

  if (operation.kind === 'clip.move') {
    if (
      operation.before.index !== clipIndex
      || !Number.isInteger(operation.after.index)
      || operation.after.index < 0
      || operation.after.index >= track.clips.length
    ) {
      return unsupportedFoundationMapping('clip_move_index_invalid')
    }
    const [moved] = track.clips.splice(clipIndex, 1)
    track.clips.splice(operation.after.index, 0, moved)
    output.push({
      type: 'track.replace',
      trackId: track.id,
      track: structuredClone(track),
      ...meta(track, clip),
    })
    return output
  }

  if (operation.kind === 'node.transform.set') {
    if (!clip.transform) {
      return unsupportedFoundationMapping('transform_target_invalid')
    }
    assertTransformRepresentable(operation.after)
    const currentScale = editorScale(clip.transform)
    if (currentScale <= 0 || Math.abs(currentScale - operation.before.scale) > 0.001) {
      return unsupportedFoundationMapping('transform_before_mismatch')
    }
    const scaleRatio = operation.after.scale / currentScale
    const width = clip.transform.width * scaleRatio
    const height = clip.transform.height * scaleRatio
    if (width <= 0 || width > 20 || height <= 0 || height > 20) {
      return unsupportedFoundationMapping('foundation_transform_size_out_of_range')
    }
    replaceClip(
      output,
      document,
      trackIndex,
      clipIndex,
      {
        ...clip,
        transform: {
          x: operation.after.x,
          y: operation.after.y,
          width,
          height,
          rotation: operation.after.rotation,
          opacity: operation.after.opacity,
        },
      },
      meta(track, clip),
    )
    return output
  }

  if (operation.kind === 'track.volume.set') {
    if (
      track.kind !== 'video'
      && track.kind !== 'voice'
      && track.kind !== 'music'
      && track.kind !== 'sfx'
    ) {
      return unsupportedFoundationMapping('volume_target_invalid')
    }
    replaceClip(
      output,
      document,
      trackIndex,
      clipIndex,
      { ...clip, volume: foundationVolume(operation.after) },
      meta(track, clip),
    )
    return output
  }

  const exhaustive: never = operation
  return unsupportedFoundationMapping('unsupported_editor_operation', {
    operation: String(exhaustive),
  })
}

export function compileFoundationEditorOperations(
  source: CreativeCompositionDocument,
  editorOperations: readonly EditorLocalOperation[],
): CompiledFoundationEditorOperations {
  const document = cloneDocument(source)
  const operations: CreativeEditOperationInput[] = []
  for (const editorOperation of editorOperations) {
    operations.push(...compileOne(document, editorOperation))
    if (operations.length > 100) {
      return unsupportedFoundationMapping('foundation_operation_limit_exceeded', {
        operationCount: operations.length,
      })
    }
  }
  if (operations.length === 0) {
    return unsupportedFoundationMapping('foundation_operation_batch_empty')
  }
  return { operations, document }
}
