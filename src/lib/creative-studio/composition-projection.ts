import {
  CREATIVE_COMPOSITION_SCHEMA_VERSION,
  creativeSha256,
  finalizeCreativeCompositionDocument,
  type CreativeCompositionDocument,
  type CreativeCompositionNode,
  type CreativeCompositionTrack,
} from '@/lib/creative-studio/composition-document'

export type ExistingProjectProjectionAsset = {
  id: string
  assetType: string
  title: string | null
  versionId: string
  version: number
  durationMs?: number | null
}

export type ExistingProjectProjectionInput = {
  compositionId?: string
  projectId: string
  ownerId: string
  brandProfileId: string
  name: string
  defaultFolder: string
  product: {
    code: string
    name: string
    priceBdt: number | null
    sourceImage: string | null
  } | null
  recipe: {
    id: string
    version: number
    name: string
  } | null
  assets: ExistingProjectProjectionAsset[]
  readonly?: boolean
}

type MediaKind = CreativeCompositionNode['kind']

const MEDIA_ORDER: MediaKind[] = [
  'video',
  'image',
  'overlay',
  'text',
  'caption',
  'voice',
  'music',
  'sfx',
]

function mediaKind(assetType: string): MediaKind {
  const normalized = assetType.trim().toLowerCase()
  if (normalized.includes('video') || normalized.includes('reel')) return 'video'
  if (normalized.includes('caption') || normalized.includes('transcript')) return 'caption'
  if (normalized.includes('voice') || normalized.includes('speech')) return 'voice'
  if (normalized.includes('music')) return 'music'
  if (normalized.includes('audio') || normalized.includes('sfx') || normalized.includes('sound')) {
    return 'sfx'
  }
  if (normalized.includes('text')) return 'text'
  if (normalized.includes('overlay')) return 'overlay'
  return 'image'
}

function stableProjectionId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}-${creativeSha256(parts).slice(0, 24)}`
}

function boundedDuration(value: number | null | undefined, kind: MediaKind): number {
  const duration = Number(value)
  if (Number.isInteger(duration) && duration > 0) {
    return Math.min(duration, 86_400_000)
  }
  if (kind === 'image' || kind === 'overlay' || kind === 'text' || kind === 'caption') {
    return 6_000
  }
  return 10_000
}

/**
 * Maps canonical CSE3 project/asset/version data into a provider-neutral,
 * read-only composition. It never writes back to the project or assets.
 */
export function projectToReadonlyComposition(
  input: ExistingProjectProjectionInput,
): {
  document: CreativeCompositionDocument
  documentHash: string
  concurrencyToken: string
} {
  const compositionId = input.compositionId
    ?? `projection:${stableProjectionId('project', input.projectId)}`
  const nodes: CreativeCompositionNode[] = []
  const trackBuckets = new Map<MediaKind, CreativeCompositionTrack['clips']>()
  const sourcePins: CreativeCompositionDocument['project']['sourcePins'] = []

  for (const asset of input.assets) {
    const kind = mediaKind(asset.assetType)
    const nodeId = stableProjectionId('node', asset.id, asset.versionId)
    const clips = trackBuckets.get(kind) ?? []
    const durationMs = boundedDuration(asset.durationMs, kind)
    const startMs = clips.reduce((total, clip) => total + clip.durationMs, 0)
    nodes.push({
      id: nodeId,
      kind,
      name: asset.title?.trim() || `${kind} v${asset.version}`,
      assetVersionId: asset.versionId,
      content: kind === 'text' || kind === 'caption'
        ? asset.title?.trim() || `${kind} v${asset.version}`
        : null,
    })
    clips.push({
      id: stableProjectionId('clip', asset.id, asset.versionId),
      nodeId,
      startMs,
      durationMs,
      sourceOffsetMs: 0,
      transform: kind === 'image'
        || kind === 'video'
        || kind === 'overlay'
        || kind === 'text'
        || kind === 'caption'
        ? { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 }
        : null,
      volume: kind === 'voice' || kind === 'music' || kind === 'sfx'
        ? { gainDb: 0, muted: false }
        : null,
    })
    trackBuckets.set(kind, clips)
    sourcePins.push({
      assetId: asset.id,
      assetVersionId: asset.versionId,
      role: 'source',
    })
  }

  const canvasId = stableProjectionId('canvas', input.projectId)
  const tracks = MEDIA_ORDER.flatMap((kind) => {
    const clips = trackBuckets.get(kind)
    if (!clips?.length) return []
    return [{
      id: stableProjectionId('track', input.projectId, kind),
      canvasId,
      kind,
      name: `${kind[0].toUpperCase()}${kind.slice(1)}`,
      order: MEDIA_ORDER.indexOf(kind),
      locked: false,
      muted: false,
      clips,
    } satisfies CreativeCompositionTrack]
  })
  const durationMs = Math.max(
    6_000,
    ...tracks.flatMap((track) => track.clips.map((clip) => clip.startMs + clip.durationMs)),
  )
  const hasVideo = tracks.some((track) => track.kind === 'video')
  const hasAudio = tracks.some((track) =>
    track.kind === 'voice' || track.kind === 'music' || track.kind === 'sfx')
  const hasStillVisual = tracks.some((track) =>
    track.kind === 'image'
    || track.kind === 'overlay'
    || track.kind === 'text'
    || track.kind === 'caption')
  const deliverableKind = (
    (hasAudio && (hasVideo || hasStillVisual))
    || (hasVideo && hasStillVisual)
  )
    ? 'mixed'
    : hasVideo
      ? 'video'
      : hasAudio
        ? 'audio'
        : 'image'

  const base: CreativeCompositionDocument = {
    schemaVersion: CREATIVE_COMPOSITION_SCHEMA_VERSION,
    compositionId,
    documentVersion: 1,
    concurrencyToken: 'projection-pending-token',
    readonly: input.readonly ?? true,
    project: {
      projectId: input.projectId,
      ownerId: input.ownerId,
      brandProfileId: input.brandProfileId,
      name: input.name,
      folder: input.defaultFolder,
      erpProduct: input.product,
      recipe: input.recipe,
      sourcePins,
    },
    canvases: [{
      id: canvasId,
      name: input.name,
      deliverableKind,
      aspect: { width: 4, height: 5 },
      resolution: { width: 1080, height: 1350 },
      durationMs,
      safeZones: [{
        id: stableProjectionId('safe-zone', input.projectId),
        label: 'Primary safe zone',
        x: 0.05,
        y: 0.05,
        width: 0.9,
        height: 0.9,
      }],
      trackIds: tracks.map((track) => track.id),
    }],
    nodes,
    tracks,
  }

  return finalizeCreativeCompositionDocument(base, {
    compositionId,
    documentVersion: 1,
    readonly: input.readonly ?? true,
  })
}
