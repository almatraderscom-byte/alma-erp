import {
  fetchProjectAssets,
  fetchStudioReview,
  type StudioReviewThread,
} from '@/agent/components/creative-studio/studio-api'
import type { StudioProjectAsset } from '@/lib/creative-studio/project-contract'
import type { CreativeCompositionView } from '@/lib/creative-studio/composition-service'
import type {
  EditorActivityEntry,
  EditorAssetReference,
  EditorClipKind,
  EditorReviewSummary,
  FoundationEditorSnapshotContext,
} from '@/lib/creative-studio/editor-agent'
import type {
  StudioReferenceBinding,
  StudioReferenceContract,
} from '@/lib/creative-studio/advanced-image-capabilities'

type AnyRecord = Record<string, unknown>

const REFERENCE_MODES = new Set([
  'generate',
  'product_to_model',
  'try_on',
  'model_swap',
  'face_to_model',
  'edit',
  'image_to_video',
])
const REFERENCE_ENGINES = new Set([
  'fashn',
  'gemini',
  'fal_fashn_v16',
  'fal_idm_vton',
  'fal_flux_fill',
  'xai_imagine',
])
const REFERENCE_ROLES = new Set([
  'product',
  'person',
  'source',
  'identity_sheet',
  'mask',
])
const REFERENCE_SOURCES = new Set(['uploaded', 'saved_model', 'derived'])

function record(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : null
}

function parseReferenceBinding(value: unknown): StudioReferenceBinding | null {
  const row = record(value)
  if (
    !row
    || typeof row.role !== 'string'
    || !REFERENCE_ROLES.has(row.role)
    || typeof row.path !== 'string'
    || !row.path
    || typeof row.source !== 'string'
    || !REFERENCE_SOURCES.has(row.source)
    || typeof row.required !== 'boolean'
  ) return null
  return {
    role: row.role as StudioReferenceBinding['role'],
    path: row.path,
    source: row.source as StudioReferenceBinding['source'],
    ...(typeof row.sourceId === 'string' && row.sourceId
      ? { sourceId: row.sourceId }
      : {}),
    required: row.required,
  }
}

function parseReferenceContract(value: unknown): StudioReferenceContract | null {
  const row = record(value)
  if (
    !row
    || row.version !== 1
    || typeof row.mode !== 'string'
    || !REFERENCE_MODES.has(row.mode)
    || typeof row.requestedEngine !== 'string'
    || !REFERENCE_ENGINES.has(row.requestedEngine)
    || typeof row.actualModel !== 'string'
    || !row.actualModel
    || !Array.isArray(row.bindings)
  ) return null
  const bindings = row.bindings.map(parseReferenceBinding)
  if (bindings.some((binding) => !binding)) return null
  return {
    version: 1,
    mode: row.mode as StudioReferenceContract['mode'],
    requestedEngine:
      row.requestedEngine as StudioReferenceContract['requestedEngine'],
    actualModel: row.actualModel,
    bindings: bindings as StudioReferenceBinding[],
  }
}

function versionReferenceContract(
  resolutionIntegrity: Record<string, unknown> | null,
): StudioReferenceContract | null {
  if (!resolutionIntegrity) return null
  return parseReferenceContract(resolutionIntegrity.referenceContract)
}

function qcLabel(value: Record<string, unknown> | null): string | null {
  if (!value) return null
  for (const key of ['summary', 'label', 'status', 'result']) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return item.trim().slice(0, 180)
  }
  return null
}

function assetStatus(value: string): EditorAssetReference['status'] {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'approved') return 'approved'
  if (normalized === 'archived') return 'archived'
  if (normalized === 'ready' || normalized === 'completed') return 'ready'
  if (
    normalized === 'qc_failed'
    || normalized === 'failed'
    || normalized === 'rejected'
  ) return 'qc_failed'
  return 'draft'
}

function mediaType(
  view: CreativeCompositionView,
  assetVersionId: string,
): EditorClipKind {
  const node = view.document.nodes.find(
    (candidate) => candidate.assetVersionId === assetVersionId,
  )
  if (node?.kind === 'video') return 'video'
  if (node?.kind === 'voice') return 'voice'
  if (node?.kind === 'music') return 'music'
  if (node?.kind === 'sfx') return 'sfx'
  if (node?.kind === 'caption' || node?.kind === 'text') return 'caption'
  return 'image'
}

function enrichedAssets(
  view: CreativeCompositionView,
  projectAssets: StudioProjectAsset[],
): EditorAssetReference[] {
  const pinnedVersionIds = new Set(
    view.document.project.sourcePins.map((pin) => pin.assetVersionId),
  )
  const enriched: EditorAssetReference[] = []
  for (const asset of projectAssets) {
    if (asset.projectId !== view.projectId) continue
    for (const version of asset.versions) {
      if (!pinnedVersionIds.has(version.id)) continue
      const artifact =
        version.variants.find((candidate) =>
          candidate.storagePath === version.storagePath)
        ?? version.variants.find((candidate) => candidate.kind === 'original')
        ?? version.variants[0]
        ?? null
      enriched.push({
        assetId: asset.id,
        assetVersionId: version.id,
        title: asset.title ?? `${asset.assetType} asset`,
        mediaType: mediaType(view, version.id),
        previewUrl: version.previewUrl ?? asset.previewUrl,
        storagePath: version.storagePath ?? asset.storagePath,
        status: assetStatus(asset.status),
        provider: version.provider,
        engine: version.engine,
        recipeVersion: version.recipeVersion,
        costBdt: Number.isFinite(version.costBdt) ? version.costBdt : null,
        qcLabel: qcLabel(version.qc),
        artifact,
        referenceContract: versionReferenceContract(
          version.resolutionIntegrity,
        ),
        lineage: version.sources.map((source) => ({
          assetId: source.id,
          title: source.title,
          relationKind: source.relationKind,
        })),
      })
    }
  }
  return enriched
}

function reviewSummary(threads: StudioReviewThread[]): EditorReviewSummary {
  const states = new Set(threads.map((thread) => thread.currentState))
  const state: EditorReviewSummary['state'] = states.has('changes_requested')
    ? 'changes_requested'
    : states.has('revised')
      ? 'revised'
      : threads.length > 0 && threads.every((thread) =>
        thread.currentState === 'approved')
        ? 'approved'
        : 'draft'
  return {
    state,
    approvedVersion: null,
    publishReady:
      threads.length > 0 && threads.every((thread) => thread.publishReady),
    openComments: threads.reduce(
      (total, thread) => total + thread.comments.length,
      0,
    ),
  }
}

function reviewActivity(threads: StudioReviewThread[]): EditorActivityEntry[] {
  const activity = threads.flatMap((thread): EditorActivityEntry[] => [
    ...thread.events.map((event) => ({
      id: event.id,
      kind: 'review' as const,
      actorName: event.actorName,
      summary: event.note?.trim()
        ? `${thread.assetTitle ?? thread.assetId}: ${event.note.trim()}`
        : `${thread.assetTitle ?? thread.assetId}: review moved to ${event.toState.replace('_', ' ')}`,
      version: null,
      createdAt: event.createdAt,
      operationIds: [],
    })),
    ...thread.comments.map((comment) => ({
      id: comment.id,
      kind: 'review' as const,
      actorName: comment.authorName,
      summary: `${thread.assetTitle ?? thread.assetId}: ${comment.body.slice(0, 180)}`,
      version: null,
      createdAt: comment.createdAt,
      operationIds: [],
    })),
  ])
  return activity.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt))
}

async function loadReviewThreads(
  assets: EditorAssetReference[],
  brandProfileId: string,
): Promise<StudioReviewThread[]> {
  const assetIds = [...new Set(assets.map((asset) => asset.assetId))]
  if (assetIds.length === 0) return []
  const results = await Promise.allSettled(
    assetIds.map((assetId) => fetchStudioReview(assetId, brandProfileId)),
  )
  return results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [])
}

/**
 * Read-only presentation enrichment. The Foundation view keeps identity,
 * scope, version and command authority; owner-only project asset hydration is
 * optional and collaborator failures deliberately fall back to canonical pins.
 */
export async function loadCreativeStudioV3EditorSnapshotContext(
  view: CreativeCompositionView,
  input: {
    brandName: string
    brandProfileId: string
    projectId: string
  },
): Promise<FoundationEditorSnapshotContext> {
  if (
    view.brandProfileId !== input.brandProfileId
    || view.projectId !== input.projectId
  ) {
    return {
      brandName: input.brandName,
      hydration: {
        projectAssets: 'not_hydrated',
        review: 'not_hydrated',
        activity: 'not_hydrated',
        history: 'not_hydrated',
      },
    }
  }

  let projectAssets: StudioProjectAsset[]
  try {
    projectAssets = await fetchProjectAssets(view.projectId)
  } catch {
    return {
      brandName: input.brandName,
      hydration: {
        projectAssets: 'not_hydrated',
        review: 'not_hydrated',
        activity: 'not_hydrated',
        history: 'not_hydrated',
      },
    }
  }

  const assets = enrichedAssets(view, projectAssets)
  const threads = await loadReviewThreads(assets, view.brandProfileId)
  const reviewHydrated = assets.length > 0 && threads.length === new Set(
    assets.map((asset) => asset.assetId),
  ).size

  return {
    brandName: input.brandName,
    assets,
    ...(reviewHydrated
      ? {
          review: reviewSummary(threads),
          activity: reviewActivity(threads),
        }
      : {}),
    hydration: {
      projectAssets: 'hydrated',
      review: reviewHydrated ? 'hydrated' : 'not_hydrated',
      activity: reviewHydrated ? 'hydrated' : 'not_hydrated',
      // Foundation GET does not yet expose durable undo/redo depth or a
      // paginated operation feed. Session receipts may still enable controls.
      history: 'not_hydrated',
    },
  }
}
