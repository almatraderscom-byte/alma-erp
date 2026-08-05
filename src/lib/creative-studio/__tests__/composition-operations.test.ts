import { describe, expect, it } from 'vitest'
import {
  applyCreativeEditOperation,
  CREATIVE_EDIT_OPERATION_BATCH_MAX_BYTES,
  compileCreativeOperationBatch,
  parseCreativeEditOperations,
  parseCreativeInverseOperation,
  type CreativeEditOperationInput,
} from '@/lib/creative-studio/composition-operations'
import {
  CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES,
  creativeCanonicalByteLength,
  creativeCanonicalString,
  type CreativeCompositionDocument,
} from '@/lib/creative-studio/composition-document'
import { projectToReadonlyComposition } from '@/lib/creative-studio/composition-projection'

function editableDocument(): CreativeCompositionDocument {
  return projectToReadonlyComposition({
    compositionId: 'composition-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    brandProfileId: 'brand-alma',
    name: 'Launch',
    defaultFolder: 'Approved',
    product: null,
    recipe: null,
    assets: [{
      id: 'asset-1',
      assetType: 'image',
      title: 'Hero',
      versionId: 'asset-version-1',
      version: 1,
    }],
    readonly: false,
  }).document
}

function editableContent(document: CreativeCompositionDocument) {
  const {
    documentVersion: _version,
    concurrencyToken: _token,
    ...content
  } = document
  return content
}

function oversizedDocument(): CreativeCompositionDocument {
  const document = editableDocument()
  const content = 'x'.repeat(100_000)
  const count = Math.ceil(CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES / content.length) + 4
  for (let index = 0; index < count; index += 1) {
    document.nodes.push({
      id: `oversized-text-${index}`,
      kind: 'text',
      name: `Oversized text ${index}`,
      assetVersionId: null,
      content,
    })
  }
  return document
}

function replaceOperations(
  document: CreativeCompositionDocument,
  seed: number,
): CreativeEditOperationInput[] {
  const node = document.nodes[0]
  const track = document.tracks[0]
  const clip = track.clips[0]
  const canvas = document.canvases[0]
  const opacity = ((seed % 89) + 10) / 100
  return [{
    type: 'node.replace',
    nodeId: node.id,
    node: { ...node, name: `Hero ${seed}` },
    selection: { nodeIds: [node.id], trackIds: [], clipIds: [] },
  }, {
    type: 'clip.replace',
    trackId: track.id,
    clipId: clip.id,
    clip: {
      ...clip,
      transform: {
        ...clip.transform!,
        x: (seed % 20) / 100,
        opacity,
      },
    },
    timeRange: { startMs: clip.startMs, endMs: clip.startMs + clip.durationMs },
  }, {
    type: 'canvas.replace',
    canvasId: canvas.id,
    canvas: {
      ...canvas,
      resolution: {
        width: 1080 + (seed % 5) * 16,
        height: 1350 + (seed % 5) * 20,
      },
    },
  }]
}

describe('Creative edit operation compiler', () => {
  it('produces stable operation IDs, fingerprints, inverse order, and no cost/effect escape', () => {
    const document = editableDocument()
    const input = {
      document,
      kind: 'APPLY' as const,
      expectedVersion: 1,
      expectedConcurrencyToken: document.concurrencyToken,
      idempotencyKey: 'apply-stable-001',
      actor: { userId: 'creator-1', role: 'creator' as const },
      operations: replaceOperations(document, 7),
    }
    const first = compileCreativeOperationBatch(input)
    const second = compileCreativeOperationBatch(input)

    expect(first).toEqual(second)
    expect(first.requestFingerprint).toHaveLength(64)
    expect(first.operations.map((operation) => operation.operationId))
      .toEqual(second.operations.map((operation) => operation.operationId))
    expect(first.operations).toHaveLength(3)
    expect(first.inverseOperations).toHaveLength(3)
    expect(first.effectClass).toBe('zero_cost_local')
    expect(first.estimatedCostBdt).toBe(0)
  })

  it('changes the canonical fingerprint when the approved operation changes', () => {
    const document = editableDocument()
    const common = {
      document,
      kind: 'APPLY' as const,
      expectedVersion: 1,
      expectedConcurrencyToken: document.concurrencyToken,
      idempotencyKey: 'apply-fingerprint-001',
      actor: { userId: 'creator-1', role: 'creator' as const },
    }
    const first = compileCreativeOperationBatch({
      ...common,
      operations: replaceOperations(document, 7),
    })
    const changed = compileCreativeOperationBatch({
      ...common,
      operations: replaceOperations(document, 8),
    })

    expect(first.requestFingerprint).not.toBe(changed.requestFingerprint)
    expect(first.batchId).not.toBe(changed.batchId)
  })

  it('rejects caller-supplied authority, fingerprint, effect, or estimate fields', () => {
    const document = editableDocument()
    const node = document.nodes[0]
    expect(() => parseCreativeEditOperations([{
      type: 'node.replace',
      nodeId: node.id,
      node,
      actorRole: 'OWNER',
      requestFingerprint: 'attacker',
      effectClass: 'EXTERNAL',
      estimatedCostBdt: 0,
    }])).toThrowError(expect.objectContaining({ code: 'invalid_composition_operation' }))
  })

  it('enforces the canonical operation-batch boundary before validation or hashing', () => {
    const content = 'ক'.repeat(100_000)
    const operations: Array<Record<string, unknown>> = []
    while (creativeCanonicalByteLength(operations) <= CREATIVE_EDIT_OPERATION_BATCH_MAX_BYTES) {
      const index = operations.length
      operations.push({
        type: 'node.replace',
        nodeId: 'text-node',
        node: {
          id: 'text-node',
          kind: 'text',
          name: `Text ${index}`,
          assetVersionId: null,
          content,
        },
      })
    }
    const oversizedBytes = creativeCanonicalByteLength(operations)
    expect(() => parseCreativeEditOperations(operations)).toThrowError(
      expect.objectContaining({
        code: 'creative_operation_batch_too_large',
        status: 413,
        details: {
          actualBytes: oversizedBytes,
          maxBytes: CREATIVE_EDIT_OPERATION_BATCH_MAX_BYTES,
        },
      }),
    )

    operations.pop()
    expect(creativeCanonicalByteLength(operations))
      .toBeLessThanOrEqual(CREATIVE_EDIT_OPERATION_BATCH_MAX_BYTES)
    expect(() => parseCreativeEditOperations(operations)).not.toThrow()
  })

  it('rejects oversized restore documents with a distinct typed boundary error', () => {
    const document = oversizedDocument()
    expect(creativeCanonicalByteLength(document))
      .toBeGreaterThan(CREATIVE_COMPOSITION_DOCUMENT_MAX_BYTES)
    expect(() => parseCreativeInverseOperation({
      type: 'document.restore',
      document,
    })).toThrowError(expect.objectContaining({
      code: 'composition_restore_payload_too_large',
      status: 413,
    }))
  })

  it('rejects inserting a voice node clip into a video track', () => {
    const document = editableDocument()
    const withVoice = applyCreativeEditOperation(document, {
      type: 'node.insert',
      node: {
        id: 'node-voice',
        kind: 'voice',
        name: 'Voice',
        assetVersionId: 'asset-version-1',
        content: null,
      },
    }).document
    const withVideoTrack = applyCreativeEditOperation(withVoice, {
      type: 'track.insert',
      track: {
        id: 'track-video',
        canvasId: withVoice.canvases[0].id,
        kind: 'video',
        name: 'Video',
        order: 0,
        locked: false,
        muted: false,
        clips: [],
      },
    }).document

    expect(() => applyCreativeEditOperation(withVideoTrack, {
      type: 'clip.insert',
      trackId: 'track-video',
      clip: {
        id: 'clip-invalid-voice',
        nodeId: 'node-voice',
        startMs: 0,
        durationMs: 1_000,
        sourceOffsetMs: 0,
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 },
        volume: null,
      },
    })).toThrowError(expect.objectContaining({ code: 'invalid_composition_operation' }))
  })

  it('property: every generated reversible batch restores exact content through its inverse', () => {
    for (let seed = 1; seed <= 96; seed += 1) {
      const document = editableDocument()
      const applied = compileCreativeOperationBatch({
        document,
        kind: 'APPLY',
        expectedVersion: document.documentVersion,
        expectedConcurrencyToken: document.concurrencyToken,
        idempotencyKey: `property-apply-${seed.toString().padStart(3, '0')}`,
        actor: { userId: 'creator-1', role: 'creator' },
        operations: replaceOperations(document, seed),
      })
      const undone = compileCreativeOperationBatch({
        document: applied.document,
        kind: 'UNDO',
        expectedVersion: applied.resultVersion,
        expectedConcurrencyToken: applied.resultConcurrencyToken,
        idempotencyKey: `property-undo-${seed.toString().padStart(3, '0')}`,
        actor: { userId: 'creator-1', role: 'creator' },
        operations: applied.inverseOperations,
        targetBatchId: applied.batchId,
        targetVersion: document.documentVersion,
        targetReference: applied.batchId,
      })

      expect(creativeCanonicalString(editableContent(undone.document)))
        .toBe(creativeCanonicalString(editableContent(document)))
    }
  })
})
