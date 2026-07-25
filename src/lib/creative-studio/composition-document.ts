import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const CREATIVE_COMPOSITION_SCHEMA_VERSION = 1 as const
export const CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024
export const CREATIVE_COMPOSITION_RESTORE_MAX_BYTES =
  CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES

const CREATIVE_CANONICAL_JSON_MAX_DEPTH = 64

export class CreativeCompositionSizeError extends Error {
  readonly code: string
  readonly status = 413
  readonly actualBytes: number
  readonly maxBytes: number

  constructor(
    code: 'composition_document_too_large' | 'composition_restore_payload_too_large',
    actualBytes: number,
    maxBytes: number,
  ) {
    super(code)
    this.name = 'CreativeCompositionSizeError'
    this.code = code
    this.actualBytes = actualBytes
    this.maxBytes = maxBytes
  }
}

export class CreativeCompositionEncodingError extends Error {
  readonly code: 'invalid_composition_json' | 'invalid_composition_restore_json'
  readonly status = 422

  constructor(code: 'invalid_composition_json' | 'invalid_composition_restore_json') {
    super(code)
    this.name = 'CreativeCompositionEncodingError'
    this.code = code
  }
}

const stableIdSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'invalid_stable_id')

const nullableStableIdSchema = stableIdSchema.nullable()

const sourcePinSchema = z.object({
  assetId: stableIdSchema,
  assetVersionId: stableIdSchema,
  role: z.enum(['source', 'reference', 'derived']),
}).strict()

const compositionProjectSchema = z.object({
  projectId: stableIdSchema,
  ownerId: stableIdSchema,
  brandProfileId: stableIdSchema,
  name: z.string().trim().min(1).max(240),
  folder: z.string().trim().min(1).max(240),
  erpProduct: z.object({
    code: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(240),
    priceBdt: z.number().int().nonnegative().nullable(),
    sourceImage: z.string().trim().max(2_000).nullable(),
  }).strict().nullable(),
  recipe: z.object({
    id: stableIdSchema,
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(240),
  }).strict().nullable(),
  sourcePins: z.array(sourcePinSchema).max(2_000),
}).strict()

export const creativeCompositionNodeSchema = z.object({
  id: stableIdSchema,
  kind: z.enum(['video', 'image', 'overlay', 'text', 'caption', 'voice', 'music', 'sfx']),
  name: z.string().trim().min(1).max(240),
  assetVersionId: nullableStableIdSchema.default(null),
  content: z.string().max(100_000).nullable().default(null),
}).strict()

const safeZoneSchema = z.object({
  id: stableIdSchema,
  label: z.string().trim().min(1).max(120),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict().superRefine((zone, context) => {
  if (zone.x + zone.width > 1.000001 || zone.y + zone.height > 1.000001) {
    context.addIssue({ code: 'custom', message: 'safe_zone_out_of_bounds' })
  }
})

export const creativeCompositionCanvasSchema = z.object({
  id: stableIdSchema,
  name: z.string().trim().min(1).max(240),
  deliverableKind: z.enum(['image', 'video', 'audio', 'mixed']),
  aspect: z.object({
    width: z.number().int().positive().max(100),
    height: z.number().int().positive().max(100),
  }).strict(),
  resolution: z.object({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  }).strict(),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  safeZones: z.array(safeZoneSchema).max(32),
  trackIds: z.array(stableIdSchema).max(512),
}).strict()

export const creativeCompositionClipSchema = z.object({
  id: stableIdSchema,
  nodeId: stableIdSchema,
  startMs: z.number().int().nonnegative().max(86_400_000),
  durationMs: z.number().int().positive().max(86_400_000),
  sourceOffsetMs: z.number().int().nonnegative().max(86_400_000).default(0),
  transform: z.object({
    x: z.number().min(-10).max(10),
    y: z.number().min(-10).max(10),
    width: z.number().positive().max(20),
    height: z.number().positive().max(20),
    rotation: z.number().min(-360).max(360),
    opacity: z.number().min(0).max(1),
  }).strict().nullable().default(null),
  volume: z.object({
    gainDb: z.number().min(-96).max(24),
    muted: z.boolean(),
  }).strict().nullable().default(null),
}).strict()

export const creativeCompositionTrackSchema = z.object({
  id: stableIdSchema,
  canvasId: stableIdSchema,
  kind: z.enum(['video', 'image', 'overlay', 'text', 'caption', 'voice', 'music', 'sfx']),
  name: z.string().trim().min(1).max(240),
  order: z.number().int().nonnegative().max(10_000),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
  clips: z.array(creativeCompositionClipSchema).max(10_000),
}).strict()

export const creativeCompositionDocumentSchema = z.object({
  schemaVersion: z.literal(CREATIVE_COMPOSITION_SCHEMA_VERSION),
  compositionId: stableIdSchema,
  documentVersion: z.number().int().positive(),
  concurrencyToken: z.string().min(16).max(128),
  readonly: z.boolean(),
  project: compositionProjectSchema,
  canvases: z.array(creativeCompositionCanvasSchema).min(1).max(128),
  nodes: z.array(creativeCompositionNodeSchema).max(10_000),
  tracks: z.array(creativeCompositionTrackSchema).max(2_000),
}).strict().superRefine((document, context) => {
  const seen = new Map<string, string>()
  const remember = (id: string, kind: string, path: Array<string | number>) => {
    const previous = seen.get(id)
    if (previous) {
      context.addIssue({
        code: 'custom',
        message: `duplicate_stable_id:${id}:${previous}:${kind}`,
        path,
      })
      return
    }
    seen.set(id, kind)
  }

  const sourceVersions = new Set<string>()
  for (const [index, pin] of document.project.sourcePins.entries()) {
    const key = `${pin.assetId}:${pin.assetVersionId}:${pin.role}`
    if (sourceVersions.has(key)) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate_source_pin',
        path: ['project', 'sourcePins', index],
      })
    }
    sourceVersions.add(key)
  }

  const pinnedAssetVersions = new Set(document.project.sourcePins.map((pin) => pin.assetVersionId))
  for (const [index, node] of document.nodes.entries()) {
    remember(node.id, 'node', ['nodes', index, 'id'])
    if (node.assetVersionId && !pinnedAssetVersions.has(node.assetVersionId)) {
      context.addIssue({
        code: 'custom',
        message: 'node_asset_version_not_pinned',
        path: ['nodes', index, 'assetVersionId'],
      })
    }
    if (
      (node.kind === 'video'
        || node.kind === 'image'
        || node.kind === 'overlay'
        || node.kind === 'voice'
        || node.kind === 'music'
        || node.kind === 'sfx')
      && !node.assetVersionId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'media_node_asset_version_required',
        path: ['nodes', index, 'assetVersionId'],
      })
    }
    if (
      (node.kind === 'text' || node.kind === 'caption')
      && !node.content?.trim()
    ) {
      context.addIssue({
        code: 'custom',
        message: 'text_node_content_required',
        path: ['nodes', index, 'content'],
      })
    }
  }

  const canvasById = new Map(document.canvases.map((canvas) => [canvas.id, canvas]))
  for (const [index, canvas] of document.canvases.entries()) {
    remember(canvas.id, 'canvas', ['canvases', index, 'id'])
    const zoneIds = new Set<string>()
    for (const [zoneIndex, zone] of canvas.safeZones.entries()) {
      if (zoneIds.has(zone.id)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate_safe_zone',
          path: ['canvases', index, 'safeZones', zoneIndex, 'id'],
        })
      }
      zoneIds.add(zone.id)
    }
  }

  const nodeById = new Map(document.nodes.map((node) => [node.id, node]))
  const nodeIds = new Set(nodeById.keys())
  const actualTracksByCanvas = new Map<string, string[]>()
  const trackOrdersByCanvas = new Map<string, Set<number>>()
  for (const [trackIndex, track] of document.tracks.entries()) {
    remember(track.id, 'track', ['tracks', trackIndex, 'id'])
    const canvas = canvasById.get(track.canvasId)
    if (!canvas) {
      context.addIssue({
        code: 'custom',
        message: 'track_canvas_not_found',
        path: ['tracks', trackIndex, 'canvasId'],
      })
      continue
    }
    const canvasTracks = actualTracksByCanvas.get(track.canvasId) ?? []
    canvasTracks.push(track.id)
    actualTracksByCanvas.set(track.canvasId, canvasTracks)
    const orders = trackOrdersByCanvas.get(track.canvasId) ?? new Set<number>()
    if (orders.has(track.order)) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate_track_order',
        path: ['tracks', trackIndex, 'order'],
      })
    }
    orders.add(track.order)
    trackOrdersByCanvas.set(track.canvasId, orders)

    for (const [clipIndex, clip] of track.clips.entries()) {
      remember(clip.id, 'clip', ['tracks', trackIndex, 'clips', clipIndex, 'id'])
      if (!nodeIds.has(clip.nodeId)) {
        context.addIssue({
          code: 'custom',
          message: 'clip_node_not_found',
          path: ['tracks', trackIndex, 'clips', clipIndex, 'nodeId'],
        })
      }
      const node = nodeById.get(clip.nodeId)
      if (node && node.kind !== track.kind) {
        context.addIssue({
          code: 'custom',
          message: 'track_node_media_kind_mismatch',
          path: ['tracks', trackIndex, 'clips', clipIndex, 'nodeId'],
        })
      }
      const visual = track.kind === 'video'
        || track.kind === 'image'
        || track.kind === 'overlay'
        || track.kind === 'text'
        || track.kind === 'caption'
      const audio = track.kind === 'voice' || track.kind === 'music' || track.kind === 'sfx'
      if (visual && !clip.transform) {
        context.addIssue({
          code: 'custom',
          message: 'visual_clip_transform_required',
          path: ['tracks', trackIndex, 'clips', clipIndex, 'transform'],
        })
      }
      if (audio && clip.transform) {
        context.addIssue({
          code: 'custom',
          message: 'audio_clip_transform_forbidden',
          path: ['tracks', trackIndex, 'clips', clipIndex, 'transform'],
        })
      }
      if (audio && !clip.volume) {
        context.addIssue({
          code: 'custom',
          message: 'audio_clip_volume_required',
          path: ['tracks', trackIndex, 'clips', clipIndex, 'volume'],
        })
      }
      if (
        track.kind !== 'video'
        && !audio
        && clip.volume
      ) {
        context.addIssue({
          code: 'custom',
          message: 'non_audio_clip_volume_forbidden',
          path: ['tracks', trackIndex, 'clips', clipIndex, 'volume'],
        })
      }
      if (canvas.durationMs > 0 && clip.startMs + clip.durationMs > canvas.durationMs) {
        context.addIssue({
          code: 'custom',
          message: 'clip_outside_canvas_duration',
          path: ['tracks', trackIndex, 'clips', clipIndex],
        })
      }
    }
  }

  for (const [canvasIndex, canvas] of document.canvases.entries()) {
    const actual = actualTracksByCanvas.get(canvas.id) ?? []
    if (
      actual.length !== canvas.trackIds.length
      || actual.some((trackId, index) => trackId !== canvas.trackIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'canvas_track_index_mismatch',
        path: ['canvases', canvasIndex, 'trackIds'],
      })
    }
  }
})

export type CreativeCompositionDocument = z.infer<typeof creativeCompositionDocumentSchema>
export type CreativeCompositionNode = z.infer<typeof creativeCompositionNodeSchema>
export type CreativeCompositionCanvas = z.infer<typeof creativeCompositionCanvasSchema>
export type CreativeCompositionTrack = z.infer<typeof creativeCompositionTrackSchema>
export type CreativeCompositionClip = z.infer<typeof creativeCompositionClipSchema>

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson }

function canonicalizeCreativeJsonAtDepth(value: unknown, depth: number): CanonicalJson {
  if (depth > CREATIVE_CANONICAL_JSON_MAX_DEPTH) {
    throw new Error('canonical_json_depth_exceeded')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_json_number')
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeCreativeJsonAtDepth(entry, depth + 1))
  }
  if (!value || typeof value !== 'object') throw new Error('invalid_json_value')
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalizeCreativeJsonAtDepth(entry, depth + 1)]),
  )
}

export function canonicalizeCreativeJson(value: unknown): CanonicalJson {
  return canonicalizeCreativeJsonAtDepth(value, 0)
}

export function creativeCanonicalString(value: unknown): string {
  return JSON.stringify(canonicalizeCreativeJson(value))
}

export function creativeCanonicalByteLength(value: unknown): number {
  return Buffer.byteLength(creativeCanonicalString(value), 'utf8')
}

export function assertCreativeCompositionDocumentSize(value: unknown): number {
  let actualBytes: number
  try {
    actualBytes = creativeCanonicalByteLength(value)
  } catch {
    throw new CreativeCompositionEncodingError('invalid_composition_json')
  }
  if (actualBytes > CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES) {
    throw new CreativeCompositionSizeError(
      'composition_document_too_large',
      actualBytes,
      CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES,
    )
  }
  return actualBytes
}

export function assertCreativeCompositionRestoreSize(value: unknown): number {
  let actualBytes: number
  try {
    actualBytes = creativeCanonicalByteLength(value)
  } catch {
    throw new CreativeCompositionEncodingError('invalid_composition_restore_json')
  }
  if (actualBytes > CREATIVE_COMPOSITION_RESTORE_MAX_BYTES) {
    throw new CreativeCompositionSizeError(
      'composition_restore_payload_too_large',
      actualBytes,
      CREATIVE_COMPOSITION_RESTORE_MAX_BYTES,
    )
  }
  return actualBytes
}

export function creativeSha256(value: unknown): string {
  return createHash('sha256').update(creativeCanonicalString(value)).digest('hex')
}

export function parseCreativeCompositionDocument(value: unknown): CreativeCompositionDocument {
  assertCreativeCompositionDocumentSize(value)
  const parsed = creativeCompositionDocumentSchema.parse(value)
  assertCreativeCompositionDocumentSize(parsed)
  return parsed
}

export function creativeCompositionDocumentHash(document: CreativeCompositionDocument): string {
  assertCreativeCompositionDocumentSize(document)
  const { concurrencyToken: _token, ...withoutToken } = document
  return creativeSha256(withoutToken)
}

export function finalizeCreativeCompositionDocument(
  document: CreativeCompositionDocument,
  input: {
    compositionId: string
    documentVersion: number
    readonly?: boolean
  },
): {
  document: CreativeCompositionDocument
  documentHash: string
  concurrencyToken: string
} {
  const withoutNewToken = {
    ...document,
    schemaVersion: CREATIVE_COMPOSITION_SCHEMA_VERSION,
    compositionId: input.compositionId,
    documentVersion: input.documentVersion,
    readonly: input.readonly ?? document.readonly,
    concurrencyToken: 'pending-concurrency-token',
  }
  const parsed = parseCreativeCompositionDocument(withoutNewToken)
  const documentHash = creativeCompositionDocumentHash(parsed)
  const concurrencyToken = creativeSha256({
    compositionId: input.compositionId,
    documentVersion: input.documentVersion,
    documentHash,
  })
  const finalized = parseCreativeCompositionDocument({
    ...parsed,
    concurrencyToken,
  })
  return { document: finalized, documentHash, concurrencyToken }
}

export function creativeCompositionNodeIndexRows(document: CreativeCompositionDocument): Array<{
  nodeKey: string
  nodeKind: string
  assetVersionId: string | null
  payload: CreativeCompositionNode
}> {
  return document.nodes.map((node) => ({
    nodeKey: node.id,
    nodeKind: node.kind,
    assetVersionId: node.assetVersionId,
    payload: node,
  }))
}
