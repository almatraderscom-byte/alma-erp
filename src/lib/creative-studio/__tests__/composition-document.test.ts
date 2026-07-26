import { describe, expect, it } from 'vitest'
import {
  CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES,
  creativeCanonicalByteLength,
  creativeCompositionDocumentHash,
  CreativeCompositionSizeError,
  finalizeCreativeCompositionDocument,
  parseCreativeCompositionDocument,
  type CreativeCompositionDocument,
} from '@/lib/creative-studio/composition-document'
import { projectToReadonlyComposition } from '@/lib/creative-studio/composition-projection'

function baseDocument(): CreativeCompositionDocument {
  return {
    schemaVersion: 1,
    compositionId: 'composition-1',
    documentVersion: 1,
    concurrencyToken: '0123456789abcdef',
    readonly: false,
    project: {
      projectId: 'project-1',
      ownerId: 'owner-1',
      brandProfileId: 'brand-alma',
      name: 'Launch',
      folder: 'Campaign',
      erpProduct: {
        code: 'ALMA-001',
        name: 'Panjabi',
        priceBdt: 2_500,
        sourceImage: 'products/alma-001.png',
      },
      recipe: { id: 'recipe-1', version: 3, name: 'Eid premium' },
      sourcePins: [{
        assetId: 'asset-image',
        assetVersionId: 'asset-version-image',
        role: 'source',
      }, {
        assetId: 'asset-voice',
        assetVersionId: 'asset-version-voice',
        role: 'source',
      }],
    },
    canvases: [{
      id: 'canvas-main',
      name: 'Main',
      deliverableKind: 'mixed',
      aspect: { width: 4, height: 5 },
      resolution: { width: 1080, height: 1350 },
      durationMs: 10_000,
      safeZones: [{
        id: 'safe-main',
        label: 'Safe',
        x: 0.05,
        y: 0.05,
        width: 0.9,
        height: 0.9,
      }],
      trackIds: ['track-image', 'track-voice'],
    }],
    nodes: [{
      id: 'node-image',
      kind: 'image',
      name: 'Hero',
      assetVersionId: 'asset-version-image',
      content: null,
    }, {
      id: 'node-voice',
      kind: 'voice',
      name: 'Owner voice',
      assetVersionId: 'asset-version-voice',
      content: null,
    }],
    tracks: [{
      id: 'track-image',
      canvasId: 'canvas-main',
      kind: 'image',
      name: 'Image',
      order: 0,
      locked: false,
      muted: false,
      clips: [{
        id: 'clip-image',
        nodeId: 'node-image',
        startMs: 0,
        durationMs: 10_000,
        sourceOffsetMs: 0,
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 },
        volume: null,
      }],
    }, {
      id: 'track-voice',
      canvasId: 'canvas-main',
      kind: 'voice',
      name: 'Voice',
      order: 1,
      locked: false,
      muted: false,
      clips: [{
        id: 'clip-voice',
        nodeId: 'node-voice',
        startMs: 0,
        durationMs: 10_000,
        sourceOffsetMs: 0,
        transform: null,
        volume: { gainDb: 0, muted: false },
      }],
    }],
  }
}

function documentAboveByteLimit(): CreativeCompositionDocument {
  const document = baseDocument()
  const content = 'x'.repeat(100_000)
  const count = Math.ceil(CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES / content.length) + 4
  for (let index = 0; index < count; index += 1) {
    document.nodes.push({
      id: `text-node-${index}`,
      kind: 'text',
      name: `Text ${index}`,
      assetVersionId: null,
      content,
    })
  }
  return document
}

describe('CreativeCompositionDocument', () => {
  it('finalizes deterministic hashes and concurrency tokens without provider fields', () => {
    const first = finalizeCreativeCompositionDocument(baseDocument(), {
      compositionId: 'composition-1',
      documentVersion: 1,
    })
    const second = finalizeCreativeCompositionDocument(baseDocument(), {
      compositionId: 'composition-1',
      documentVersion: 1,
    })

    expect(first).toEqual(second)
    expect(first.documentHash).toHaveLength(64)
    expect(first.concurrencyToken).toHaveLength(64)
    expect(creativeCompositionDocumentHash(first.document)).toBe(first.documentHash)
    expect(JSON.stringify(first.document)).not.toMatch(
      /"provider"|"engine"|"model"|"requestId"|"seed"|"cost"/,
    )
  })

  it('rejects track ↔ clip ↔ node media-kind mismatches', () => {
    const document = baseDocument()
    document.tracks[0].clips[0].nodeId = 'node-voice'

    expect(() => parseCreativeCompositionDocument(document)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ message: 'track_node_media_kind_mismatch' }),
        ]),
      }),
    )
  })

  it('enforces truthful transform and volume modality', () => {
    const missingVisualTransform = baseDocument()
    missingVisualTransform.tracks[0].clips[0].transform = null
    expect(() => parseCreativeCompositionDocument(missingVisualTransform)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ message: 'visual_clip_transform_required' }),
        ]),
      }),
    )

    const transformedAudio = baseDocument()
    transformedAudio.tracks[1].clips[0].transform = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      rotation: 0,
      opacity: 1,
    }
    expect(() => parseCreativeCompositionDocument(transformedAudio)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ message: 'audio_clip_transform_forbidden' }),
        ]),
      }),
    )

    const missingAudioVolume = baseDocument()
    missingAudioVolume.tracks[1].clips[0].volume = null
    expect(() => parseCreativeCompositionDocument(missingAudioVolume)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ message: 'audio_clip_volume_required' }),
        ]),
      }),
    )
  })

  it('requires media nodes to pin canonical asset versions', () => {
    const unpinned = baseDocument()
    unpinned.nodes[0].assetVersionId = 'another-version'
    expect(() => parseCreativeCompositionDocument(unpinned)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ message: 'node_asset_version_not_pinned' }),
        ]),
      }),
    )
  })

  it('enforces the exported canonical document byte boundary with a typed 413', () => {
    const document = documentAboveByteLimit()
    const oversizedBytes = creativeCanonicalByteLength(document)
    expect(oversizedBytes).toBeGreaterThan(CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES)
    expect(() => parseCreativeCompositionDocument(document)).toThrowError(
      expect.objectContaining<Partial<CreativeCompositionSizeError>>({
        code: 'composition_document_too_large',
        status: 413,
        actualBytes: oversizedBytes,
        maxBytes: CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES,
      }),
    )

    while (
      creativeCanonicalByteLength(document) > CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES
    ) {
      document.nodes.pop()
    }
    expect(creativeCanonicalByteLength(document))
      .toBeLessThanOrEqual(CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES)
    expect(() => parseCreativeCompositionDocument(document)).not.toThrow()
  })

  it('measures canonical UTF-8 bytes rather than JavaScript character count', () => {
    const value = { text: 'বাংলা' }
    expect(creativeCanonicalByteLength(value)).toBeGreaterThan(
      JSON.stringify(value).length,
    )
  })

  it('projects existing project data read-only without mutating or copying provider metadata', () => {
    const source = {
      projectId: 'project-1',
      ownerId: 'owner-1',
      brandProfileId: 'brand-alma',
      name: 'Existing project',
      defaultFolder: 'Approved',
      product: null,
      recipe: null,
      assets: [{
        id: 'asset-1',
        assetType: 'image',
        title: 'Existing hero',
        versionId: 'asset-version-1',
        version: 4,
        durationMs: null,
      }],
      readonly: true,
    }
    const snapshot = structuredClone(source)
    const projection = projectToReadonlyComposition(source)

    expect(source).toEqual(snapshot)
    expect(projection.document.readonly).toBe(true)
    expect(projection.document.project.sourcePins).toEqual([{
      assetId: 'asset-1',
      assetVersionId: 'asset-version-1',
      role: 'source',
    }])
    expect(projection.document.nodes[0]).toMatchObject({
      kind: 'image',
      assetVersionId: 'asset-version-1',
    })
  })

  it('derives truthful canvas modality for audio-only and mixed projections', () => {
    const common = {
      projectId: 'project-1',
      ownerId: 'owner-1',
      brandProfileId: 'brand-alma',
      name: 'Existing project',
      defaultFolder: 'Approved',
      product: null,
      recipe: null,
      readonly: true,
    }
    const voice = {
      id: 'asset-voice',
      assetType: 'voice',
      title: 'Owner voice',
      versionId: 'asset-version-voice',
      version: 1,
      durationMs: 4_000,
    }
    const image = {
      id: 'asset-image',
      assetType: 'image',
      title: 'Hero',
      versionId: 'asset-version-image',
      version: 1,
      durationMs: null,
    }

    const audio = projectToReadonlyComposition({ ...common, assets: [voice] })
    const mixed = projectToReadonlyComposition({ ...common, assets: [image, voice] })

    expect(audio.document.canvases[0].deliverableKind).toBe('audio')
    expect(audio.document.tracks[0].clips[0]).toMatchObject({
      transform: null,
      volume: { gainDb: 0, muted: false },
    })
    expect(mixed.document.canvases[0].deliverableKind).toBe('mixed')
  })
})
