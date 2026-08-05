import type {
  CreativeCompositionDocument,
  CreativeCompositionNode,
} from '@/lib/creative-studio/composition-document'
import type { CreativeCompositionView } from '@/lib/creative-studio/composition-service'
import {
  EDITOR_AGENT_CONTRACT_VERSION,
  type EditorActivityEntry,
  type EditorAssetReference,
  type EditorCanvas,
  type EditorClip,
  type EditorClipKind,
  type EditorCompositionScope,
  type EditorCompositionSnapshot,
  type EditorReviewSummary,
  type EditorTrack,
  type EditorTrackKind,
  type EditorTransform,
} from '@/lib/creative-studio/editor-agent/contracts'
import {
  FoundationCompositionPortError,
  unsupportedFoundationMapping,
} from '@/lib/creative-studio/editor-agent/foundation-errors'

type AnyRecord = Record<string, unknown>

export type FoundationEditorSnapshotContext = {
  brandName?: string
  background?: string
  assets?: readonly EditorAssetReference[]
  review?: EditorReviewSummary
  activity?: readonly EditorActivityEntry[]
  canUndo?: boolean
  canRedo?: boolean
  latestAgentBatchId?: string | null
  canRollbackLatestAgentBatch?: boolean
  hydration?: EditorCompositionSnapshot['hydration']
}

function record(value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return value as AnyRecord
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return value
}

function requiredInteger(value: unknown): number {
  if (!Number.isInteger(value)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return value as number
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return value
}

function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  return value
}

/**
 * Runtime-checks the authenticated API envelope before any value is projected
 * into the editor. The Foundation route owns full schema validation; this
 * client boundary checks every identity/version field and collection it uses.
 */
export function parseFoundationCompositionView(value: unknown): CreativeCompositionView {
  const view = record(value)
  const document = record(view.document)
  const project = record(document.project)
  const history = record(view.history)
  requiredString(view.id)
  requiredString(view.brandProfileId)
  requiredString(view.projectId)
  requiredString(view.title)
  requiredInteger(view.currentVersion)
  requiredString(view.concurrencyToken)
  requiredBoolean(view.readonly)
  const accessRole = requiredString(view.accessRole)
  if (!['owner', 'creator', 'reviewer'].includes(accessRole)) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502)
  }
  requiredInteger(document.schemaVersion)
  requiredString(document.compositionId)
  requiredInteger(document.documentVersion)
  requiredString(document.concurrencyToken)
  requiredBoolean(document.readonly)
  requiredString(project.projectId)
  requiredString(project.brandProfileId)
  requiredString(project.name)
  requiredArray(project.sourcePins)
  requiredArray(document.canvases)
  requiredArray(document.nodes)
  requiredArray(document.tracks)
  requiredBoolean(history.canUndo)
  requiredBoolean(history.canRedo)
  requiredInteger(history.undoDepth)
  requiredInteger(history.redoDepth)
  if (history.latestAgentBatchId !== null) requiredString(history.latestAgentBatchId)
  requiredBoolean(history.canRollbackLatestAgentBatch)
  requiredArray(history.rollbackPoints)
  requiredArray(history.activity)

  if (
    view.id !== document.compositionId
    || view.projectId !== project.projectId
    || view.brandProfileId !== project.brandProfileId
    || view.currentVersion !== document.documentVersion
    || view.concurrencyToken !== document.concurrencyToken
    || view.readonly !== document.readonly
  ) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502, {
      reason: 'composition_identity_or_version_mismatch',
    })
  }
  return value as CreativeCompositionView
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b > 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a || 1
}

function aspectRatio(
  aspect: CreativeCompositionDocument['canvases'][number]['aspect'],
): EditorCanvas['aspectRatio'] {
  const divisor = gcd(aspect.width, aspect.height)
  const ratio = `${aspect.width / divisor}:${aspect.height / divisor}`
  if (ratio === '4:5' || ratio === '1:1' || ratio === '9:16' || ratio === '16:9') {
    return ratio
  }
  return unsupportedFoundationMapping('unsupported_canvas_aspect', { ratio })
}

function editorTrackKind(
  kind: CreativeCompositionDocument['tracks'][number]['kind'],
): EditorTrackKind {
  if (kind === 'video') return 'video'
  if (kind === 'image' || kind === 'overlay' || kind === 'text') return 'overlay'
  if (kind === 'caption') return 'caption'
  if (kind === 'voice' || kind === 'music' || kind === 'sfx') return kind
  return unsupportedFoundationMapping('unsupported_track_kind', { kind })
}

function editorClipKind(node: CreativeCompositionNode): EditorClipKind {
  if (node.kind === 'video') return 'video'
  if (node.kind === 'image' || node.kind === 'overlay') return 'image'
  if (node.kind === 'text' || node.kind === 'caption') return 'caption'
  if (node.kind === 'voice' || node.kind === 'music' || node.kind === 'sfx') {
    return node.kind
  }
  return unsupportedFoundationMapping('unsupported_node_kind', { kind: node.kind })
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    return unsupportedFoundationMapping('non_finite_foundation_value', { label })
  }
  return value
}

function round(value: number, precision = 3): number {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function editorTransform(
  transform: CreativeCompositionDocument['tracks'][number]['clips'][number]['transform'],
): EditorTransform {
  if (!transform) {
    return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
  }
  const scale = Math.sqrt(
    finite(transform.width, 'transform.width')
    * finite(transform.height, 'transform.height'),
  )
  if (
    transform.x < -2
    || transform.x > 2
    || transform.y < -2
    || transform.y > 2
    || scale < 0.1
    || scale > 4
  ) {
    return unsupportedFoundationMapping('transform_outside_editor_range')
  }
  return {
    x: round(transform.x),
    y: round(transform.y),
    scale: round(scale),
    rotation: round(transform.rotation),
    opacity: round(transform.opacity),
  }
}

function editorVolume(
  volume: CreativeCompositionDocument['tracks'][number]['clips'][number]['volume'],
): number {
  if (!volume) return 1
  if (volume.gainDb > 0) {
    return unsupportedFoundationMapping('positive_gain_not_supported', {
      gainDb: volume.gainDb,
    })
  }
  if (volume.muted) return 0
  return round(Math.max(0, Math.min(1, 10 ** (volume.gainDb / 20))))
}

function pinnedAssetId(
  document: CreativeCompositionDocument,
  assetVersionId: string,
): string {
  const assetIds = [...new Set(
    document.project.sourcePins
      .filter((pin) => pin.assetVersionId === assetVersionId)
      .map((pin) => pin.assetId),
  )]
  if (assetIds.length !== 1) {
    return unsupportedFoundationMapping('ambiguous_asset_version_pin', {
      assetVersionId,
      matchCount: assetIds.length,
    })
  }
  return assetIds[0]
}

function derivedAssets(
  document: CreativeCompositionDocument,
): EditorAssetReference[] {
  const assets = new Map<string, EditorAssetReference>()
  for (const node of document.nodes) {
    if (!node.assetVersionId) continue
    const assetId = pinnedAssetId(document, node.assetVersionId)
    if (assets.has(node.assetVersionId)) continue
    assets.set(node.assetVersionId, {
      assetId,
      assetVersionId: node.assetVersionId,
      title: node.name,
      mediaType: editorClipKind(node),
      previewUrl: null,
      storagePath: null,
      status: 'draft',
      provider: null,
      engine: null,
      recipeVersion: document.project.recipe?.version ?? null,
      costBdt: null,
      qcLabel: 'Canonical version pinned; asset metadata not hydrated',
      artifact: null,
      referenceContract: null,
      lineage: [],
    })
  }
  return [...assets.values()]
}

function mergedAssets(
  document: CreativeCompositionDocument,
  enriched: readonly EditorAssetReference[] | undefined,
): EditorAssetReference[] {
  const assets = new Map(
    derivedAssets(document).map((asset) => [asset.assetVersionId, asset]),
  )
  for (const asset of enriched ?? []) {
    const pinned = assets.get(asset.assetVersionId)
    if (pinned && pinned.assetId !== asset.assetId) {
      unsupportedFoundationMapping('enriched_asset_identity_mismatch', {
        assetVersionId: asset.assetVersionId,
      })
    }
    assets.set(asset.assetVersionId, structuredClone(asset))
  }
  return [...assets.values()]
}

function clipStatus(
  asset: EditorAssetReference | undefined,
): EditorClip['status'] {
  if (!asset || asset.status === 'draft') return 'local'
  if (asset.status === 'ready' || asset.status === 'approved') return 'ready'
  return 'needs_review'
}

function assertScope(
  view: CreativeCompositionView,
  scope: EditorCompositionScope,
): void {
  if (
    view.id !== scope.compositionId
    || view.projectId !== scope.projectId
    || view.brandProfileId !== scope.brandProfileId
  ) {
    throw new FoundationCompositionPortError('invalid_foundation_response', 502, {
      reason: 'requested_scope_mismatch',
    })
  }
}

function projectFoundationCompositionToEditorUnchecked(
  rawView: CreativeCompositionView,
  scope: EditorCompositionScope,
  context: FoundationEditorSnapshotContext = {},
): EditorCompositionSnapshot {
  const view = parseFoundationCompositionView(rawView)
  assertScope(view, scope)
  const { document } = view
  if (document.schemaVersion !== 1) {
    return unsupportedFoundationMapping('unsupported_document_schema', {
      schemaVersion: document.schemaVersion,
    })
  }
  if (document.canvases.length !== 1) {
    return unsupportedFoundationMapping('editor_requires_single_canvas', {
      canvasCount: document.canvases.length,
    })
  }
  const canvas = document.canvases[0]
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]))
  const trackById = new Map(document.tracks.map((track) => [track.id, track]))
  const assets = mergedAssets(document, context.assets)
  const assetByVersion = new Map(assets.map((asset) => [asset.assetVersionId, asset]))

  const tracks: EditorTrack[] = canvas.trackIds.map((trackId) => {
    const track = trackById.get(trackId)
    if (!track || track.canvasId !== canvas.id) {
      return unsupportedFoundationMapping('canvas_track_missing', { trackId })
    }
    const kind = editorTrackKind(track.kind)
    return {
      id: track.id,
      kind,
      label: track.name,
      muted: track.muted,
      locked: track.locked,
      clips: track.clips.map((source): EditorClip => {
        const node = nodeById.get(source.nodeId)
        if (!node || node.kind !== track.kind) {
          return unsupportedFoundationMapping('clip_node_kind_mismatch', {
            clipId: source.id,
          })
        }
        const assetId = node.assetVersionId
          ? pinnedAssetId(document, node.assetVersionId)
          : null
        const asset = node.assetVersionId
          ? assetByVersion.get(node.assetVersionId)
          : undefined
        return {
          id: source.id,
          trackId: track.id,
          kind: editorClipKind(node),
          label: node.name,
          startSec: round(source.startMs / 1_000),
          endSec: round((source.startMs + source.durationMs) / 1_000),
          sourceStartSec: round(source.sourceOffsetMs / 1_000),
          sourceEndSec: round((source.sourceOffsetMs + source.durationMs) / 1_000),
          assetId,
          assetVersionId: node.assetVersionId,
          text: node.content,
          volume: editorVolume(source.volume),
          transform: editorTransform(source.transform),
          locked: track.locked,
          status: clipStatus(asset),
        }
      }),
    }
  })

  return {
    contractVersion: EDITOR_AGENT_CONTRACT_VERSION,
    scope: { ...scope },
    name: view.title,
    brandName: context.brandName?.trim() || view.brandProfileId,
    projectName: document.project.name,
    recipeName: document.project.recipe?.name ?? null,
    recipeVersion: document.project.recipe?.version ?? null,
    productCode: document.project.erpProduct?.code ?? null,
    productName: document.project.erpProduct?.name ?? null,
    version: document.documentVersion,
    concurrencyToken: document.concurrencyToken,
    canvas: {
      aspectRatio: aspectRatio(canvas.aspect),
      width: canvas.resolution.width,
      height: canvas.resolution.height,
      durationSec: round(canvas.durationMs / 1_000),
      safeZone: canvas.safeZones.length > 0,
      background: context.background ?? '#1f2937',
    },
    tracks,
    assets,
    review: context.review
      ? structuredClone(context.review)
      : {
          state: 'draft',
          approvedVersion: null,
          publishReady: false,
          openComments: 0,
        },
    activity: [...(context.activity ?? [])].map((entry) => structuredClone(entry)),
    canUndo: context.canUndo ?? false,
    canRedo: context.canRedo ?? false,
    latestAgentBatchId: context.latestAgentBatchId ?? null,
    canRollbackLatestAgentBatch:
      context.canRollbackLatestAgentBatch ?? false,
    hydration: context.hydration
      ? structuredClone(context.hydration)
      : {
          projectAssets: 'not_hydrated',
          review: 'not_hydrated',
          activity: 'not_hydrated',
          history: 'not_hydrated',
        },
  }
}

export function projectFoundationCompositionToEditor(
  rawView: CreativeCompositionView,
  scope: EditorCompositionScope,
  context: FoundationEditorSnapshotContext = {},
): EditorCompositionSnapshot {
  try {
    return projectFoundationCompositionToEditorUnchecked(rawView, scope, context)
  } catch (error) {
    if (error instanceof FoundationCompositionPortError) throw error
    throw new FoundationCompositionPortError(
      'invalid_foundation_response',
      502,
      {
        reason: error instanceof Error
          ? error.message
          : 'foundation_projection_failed',
      },
    )
  }
}
