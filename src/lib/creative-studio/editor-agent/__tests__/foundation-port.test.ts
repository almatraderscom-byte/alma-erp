import { describe, expect, it } from 'vitest'
import {
  compileFoundationEditorOperations,
  createFoundationCompositionCommandPort,
  createOperationProposal,
  FoundationCompositionPortError,
  type EditorActor,
  type EditorCompositionScope,
  type EditorCompositionSnapshot,
  type EditorLocalOperation,
  type EditorPendingAction,
} from '@/lib/creative-studio/editor-agent'
import { FoundationApiHarness } from '@/lib/creative-studio/editor-agent/__fixtures__/foundation-api'
import { createEditorFixtureSnapshot } from '@/lib/creative-studio/editor-agent/__fixtures__/editor-snapshot'

const OWNER: EditorActor = {
  userId: 'owner-1',
  name: 'Owner',
  role: 'owner',
}

const SCOPE: EditorCompositionScope = {
  brandProfileId: 'brand-alma',
  projectId: 'project-1',
  compositionId: 'composition-1',
}

function musicClip(snapshot: EditorCompositionSnapshot) {
  const track = snapshot.tracks.find((candidate) => candidate.kind === 'music')
  const clip = track?.clips[0]
  if (!track || !clip) throw new Error('music_fixture_missing')
  return { track, clip }
}

function captionClip(snapshot: EditorCompositionSnapshot) {
  const track = snapshot.tracks.find((candidate) => candidate.kind === 'caption')
  const clip = track?.clips[0]
  if (!track || !clip) throw new Error('caption_fixture_missing')
  return { track, clip }
}

async function volumeProposal(
  snapshot: EditorCompositionSnapshot,
  after: number,
  pendingActions: EditorPendingAction[] = [],
  origin: 'human' | 'agent' = 'human',
) {
  const { track, clip } = musicClip(snapshot)
  return createOperationProposal({
    origin,
    snapshot,
    actor: OWNER,
    instruction: `Set music to ${Math.round(after * 100)}%`,
    normalizedInstruction: `set music to ${Math.round(after * 100)}%`,
    operations: [{
      id: `volume-v${snapshot.version}-${String(after).replace('.', '-')}`,
      label: 'Set music volume',
      kind: 'track.volume.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: track.id, clipId: clip.id },
      before: clip.volume,
      after,
    }],
    pendingActions,
  })
}

async function captionProposal(
  snapshot: EditorCompositionSnapshot,
  text: string,
) {
  const { track, clip } = captionClip(snapshot)
  return createOperationProposal({
    origin: 'human',
    snapshot,
    actor: OWNER,
    instruction: `Set caption to ${text}`,
    normalizedInstruction: `set caption to ${text}`,
    operations: [{
      id: `caption-v${snapshot.version}`,
      label: 'Set caption',
      kind: 'caption.text.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: track.id, clipId: clip.id },
      before: clip.text ?? '',
      after: text,
    }],
  })
}

describe('Foundation-backed CompositionCommandPort', () => {
  it('loads an exact-scope Foundation document and preserves injected A+B metadata', async () => {
    const api = new FoundationApiHarness()
    const artifactAsset = createEditorFixtureSnapshot().assets[0]
    const port = createFoundationCompositionCommandPort({
      fetcher: api.fetch,
      loadSnapshotContext: (view) => ({
        brandName: 'ALMA Lifestyle',
        assets: [{
          ...artifactAsset,
          assetId: 'asset-video',
          assetVersionId: 'version-video-1',
          title: 'Opening · verified',
        }],
        review: {
          state: 'approved',
          approvedVersion: view.currentVersion,
          publishReady: false,
          openComments: 0,
        },
      }),
    })

    const snapshot = await port.load(SCOPE)

    expect(snapshot).toMatchObject({
      scope: SCOPE,
      version: 1,
      brandName: 'ALMA Lifestyle',
      projectName: 'Eid launch',
      canUndo: false,
      canRedo: false,
    })
    expect(snapshot.tracks.map((track) => track.kind)).toEqual([
      'video',
      'caption',
      'music',
    ])
    expect(
      snapshot.assets.find((asset) => asset.assetVersionId === 'version-video-1'),
    ).toMatchObject({
      artifact: {
        validation: 'verified',
        width: 1080,
        height: 1350,
      },
      referenceContract: {
        version: 1,
      },
    })
    expect(api.requests).toEqual([
      expect.objectContaining({
        method: 'GET',
        pathname: '/api/assistant/creative-studio/compositions/composition-1',
      }),
    ])
  })

  it('maps all reversible editor operations deterministically and rejects lossy trim', async () => {
    const api = new FoundationApiHarness()
    const port = createFoundationCompositionCommandPort({ fetcher: api.fetch })
    const snapshot = await port.load(SCOPE)
    const video = snapshot.tracks.find((track) => track.kind === 'video')
    const caption = captionClip(snapshot)
    const music = musicClip(snapshot)
    if (!video || video.clips.length !== 2) throw new Error('video_fixture_missing')
    const first = video.clips[0]
    const second = video.clips[1]
    const operations: EditorLocalOperation[] = [{
      id: 'move',
      label: 'Move detail',
      kind: 'clip.move',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: video.id, clipId: second.id },
      before: { index: 1 },
      after: { index: 0 },
    }, {
      id: 'trim',
      label: 'Trim opening',
      kind: 'clip.trim',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: video.id, clipId: first.id },
      before: {
        startSec: first.startSec,
        endSec: first.endSec,
        sourceStartSec: first.sourceStartSec,
        sourceEndSec: first.sourceEndSec,
      },
      after: {
        startSec: 0.5,
        endSec: 5.5,
        sourceStartSec: 0.5,
        sourceEndSec: 5.5,
      },
    }, {
      id: 'transform',
      label: 'Scale opening',
      kind: 'node.transform.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: video.id, clipId: first.id },
      before: first.transform,
      after: { ...first.transform, x: 0.1, scale: 1.2 },
    }, {
      id: 'video-volume',
      label: 'Lower opening',
      kind: 'track.volume.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: video.id, clipId: first.id },
      before: first.volume,
      after: 0.5,
    }, {
      id: 'split',
      label: 'Split opening',
      kind: 'clip.split',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: video.id, clipId: first.id },
      before: { clipId: first.id, startSec: 0.5, endSec: 5.5 },
      after: {
        leftClipId: `${first.id}-left`,
        rightClipId: `${first.id}-right`,
        splitAtSec: 3,
      },
    }, {
      id: 'caption-text',
      label: 'Caption text',
      kind: 'caption.text.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: caption.track.id, clipId: caption.clip.id },
      before: caption.clip.text ?? '',
      after: 'আজই অর্ডার করুন',
    }, {
      id: 'caption-time',
      label: 'Caption timing',
      kind: 'caption.timing.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: caption.track.id, clipId: caption.clip.id },
      before: {
        startSec: caption.clip.startSec,
        endSec: caption.clip.endSec,
      },
      after: { startSec: 1, endSec: 4 },
    }, {
      id: 'music-volume',
      label: 'Music volume',
      kind: 'track.volume.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: music.track.id, clipId: music.clip.id },
      before: music.clip.volume,
      after: 0.2,
    }]

    const firstCompilation = compileFoundationEditorOperations(
      api.snapshot().document,
      operations,
    )
    const secondCompilation = compileFoundationEditorOperations(
      api.snapshot().document,
      operations,
    )

    expect(firstCompilation).toEqual(secondCompilation)
    expect(firstCompilation.operations.map((operation) => operation.type)).toEqual([
      'track.replace',
      'clip.replace',
      'clip.replace',
      'clip.replace',
      'clip.remove',
      'clip.insert',
      'clip.insert',
      'node.replace',
      'clip.replace',
      'clip.replace',
    ])
    const lossyTrim = structuredClone(operations[1])
    if (lossyTrim.kind !== 'clip.trim') throw new Error('trim_fixture_invalid')
    lossyTrim.after.sourceEndSec = 5
    expect(() => compileFoundationEditorOperations(
      api.snapshot().document,
      [lossyTrim],
    )).toThrowError(expect.objectContaining({
      code: 'unsupported_foundation_mapping',
    }))
  })

  it('validates through Foundation without writing and applies with its audit batch ID', async () => {
    const api = new FoundationApiHarness()
    const port = createFoundationCompositionCommandPort({
      fetcher: api.fetch,
      now: () => '2026-07-26T01:00:00.000Z',
    })
    const snapshot = await port.load(SCOPE)
    const proposal = await volumeProposal(snapshot, 0.4)

    await expect(port.validateLocal({ proposal, actor: OWNER })).resolves.toMatchObject({
      ok: true,
      code: 'valid',
      currentVersion: 1,
    })
    expect(api.snapshot().currentVersion).toBe(1)
    const receipt = await port.applyLocal({ proposal, actor: OWNER })

    expect(receipt).toMatchObject({
      status: 'applied',
      auditId: expect.stringMatching(/^cob_[a-f0-9]{32}$/),
      batchId: expect.stringMatching(/^cob_[a-f0-9]{32}$/),
      operationIds: [proposal.operations[0].id],
      pendingActionIds: [],
      snapshot: {
        version: 2,
        canUndo: true,
        canRedo: false,
      },
    })
    expect(receipt.auditId).toBe(receipt.batchId)
    expect(musicClip(receipt.snapshot).clip.volume).toBe(0.4)
    expect(receipt.snapshot.activity.at(-1)).toMatchObject({
      id: receipt.batchId,
      kind: 'edit',
      version: 2,
    })
    const validate = api.requests.find((entry) =>
      entry.pathname.endsWith('/operations/validate'))
    const apply = api.requests.find((entry) =>
      entry.pathname.endsWith('/operations/apply'))
    expect(validate?.body).toEqual(apply?.body)
    expect(apply?.body).toEqual({
      expectedVersion: 1,
      expectedConcurrencyToken: snapshot.concurrencyToken,
      idempotencyKey: `editor-human-apply-${proposal.fingerprint.replace('csplan-v1-', '')}`,
      brandProfileId: 'brand-alma',
      operations: expect.any(Array),
    })
  })

  it('invalidates a locally current proposal when the authoritative version/token changed', async () => {
    const api = new FoundationApiHarness()
    const port = createFoundationCompositionCommandPort({ fetcher: api.fetch })
    const snapshot = await port.load(SCOPE)
    const proposal = await volumeProposal(snapshot, 0.3)
    api.advanceExternally()

    await expect(port.validateLocal({ proposal, actor: OWNER })).resolves.toMatchObject({
      ok: false,
      code: 'stale_version',
      currentVersion: 2,
      currentConcurrencyToken: api.snapshot().concurrencyToken,
    })
    expect(api.snapshot().currentVersion).toBe(2)
  })

  it('replays the exact idempotency key after a lost response and surfaces conflicts', async () => {
    const api = new FoundationApiHarness()
    const port = createFoundationCompositionCommandPort({ fetcher: api.fetch })
    const snapshot = await port.load(SCOPE)
    const proposal = await volumeProposal(snapshot, 0.35)
    api.loseNextApplyResponseAfterCommit()

    await expect(port.applyLocal({ proposal, actor: OWNER })).rejects.toMatchObject({
      code: 'network_unavailable',
    })
    expect(api.snapshot().currentVersion).toBe(2)
    const replay = await port.applyLocal({ proposal, actor: OWNER })
    expect(replay.snapshot.version).toBe(2)
    expect(musicClip(replay.snapshot).clip.volume).toBe(0.35)
    expect(
      api.requests.filter((entry) => entry.pathname.endsWith('/operations/validate')),
    ).toHaveLength(1)
    const applyBodies = api.requests
      .filter((entry) => entry.pathname.endsWith('/operations/apply'))
      .map((entry) => entry.body)
    expect(applyBodies).toHaveLength(2)
    expect(applyBodies[0]).toEqual(applyBodies[1])

    const conflictApi = new FoundationApiHarness()
    const conflictPort = createFoundationCompositionCommandPort({
      fetcher: conflictApi.fetch,
    })
    const conflictSnapshot = await conflictPort.load(SCOPE)
    const conflictProposal = await volumeProposal(conflictSnapshot, 0.25)
    conflictApi.rejectNextApplyAsIdempotencyConflict()
    await expect(
      conflictPort.applyLocal({ proposal: conflictProposal, actor: OWNER }),
    ).rejects.toBeInstanceOf(FoundationCompositionPortError)
    await expect(
      conflictPort.applyLocal({ proposal: conflictProposal, actor: OWNER }),
    ).resolves.toMatchObject({ status: 'applied' })
  })

  it('supports multi-level Foundation undo/redo as appended versions', async () => {
    const api = new FoundationApiHarness()
    const port = createFoundationCompositionCommandPort({ fetcher: api.fetch })
    let snapshot = await port.load(SCOPE)
    const firstProposal = await volumeProposal(snapshot, 0.8)
    const first = await port.applyLocal({ proposal: firstProposal, actor: OWNER })
    snapshot = first.snapshot
    const secondProposal = await volumeProposal(snapshot, 0.4)
    const second = await port.applyLocal({ proposal: secondProposal, actor: OWNER })

    const undoB = await port.undo({
      scope: SCOPE,
      expectedVersion: second.snapshot.version,
      expectedConcurrencyToken: second.snapshot.concurrencyToken,
      actor: OWNER,
    })
    const undoA = await port.undo({
      scope: SCOPE,
      expectedVersion: undoB.snapshot.version,
      expectedConcurrencyToken: undoB.snapshot.concurrencyToken,
      actor: OWNER,
    })
    const redoA = await port.redo({
      scope: SCOPE,
      expectedVersion: undoA.snapshot.version,
      expectedConcurrencyToken: undoA.snapshot.concurrencyToken,
      actor: OWNER,
    })
    const redoB = await port.redo({
      scope: SCOPE,
      expectedVersion: redoA.snapshot.version,
      expectedConcurrencyToken: redoA.snapshot.concurrencyToken,
      actor: OWNER,
    })

    expect([
      first.snapshot.version,
      second.snapshot.version,
      undoB.snapshot.version,
      undoA.snapshot.version,
      redoA.snapshot.version,
      redoB.snapshot.version,
    ]).toEqual([2, 3, 4, 5, 6, 7])
    expect(musicClip(undoB.snapshot).clip.volume).toBe(0.8)
    expect(musicClip(undoA.snapshot).clip.volume).toBe(1)
    expect(musicClip(redoA.snapshot).clip.volume).toBe(0.8)
    expect(musicClip(redoB.snapshot).clip.volume).toBe(0.4)
    expect(undoA.snapshot.canUndo).toBe(false)
    expect(redoB.snapshot.canRedo).toBe(false)
  })

  it('rolls back through the exact Foundation rollback point for an applied batch', async () => {
    const api = new FoundationApiHarness()
    const port = createFoundationCompositionCommandPort({ fetcher: api.fetch })
    const initial = await port.load(SCOPE)
    const firstProposal = await volumeProposal(initial, 0.5)
    const first = await port.applyLocal({ proposal: firstProposal, actor: OWNER })
    const secondProposal = await captionProposal(first.snapshot, 'Limited edition')
    const second = await port.applyLocal({ proposal: secondProposal, actor: OWNER })

    const rolledBack = await port.rollback({
      scope: SCOPE,
      expectedVersion: second.snapshot.version,
      expectedConcurrencyToken: second.snapshot.concurrencyToken,
      actor: OWNER,
      batchId: first.batchId,
    })

    expect(rolledBack).toMatchObject({
      status: 'rolled_back',
      snapshot: { version: 4 },
    })
    expect(musicClip(rolledBack.snapshot).clip.volume).toBe(1)
    expect(captionClip(rolledBack.snapshot).clip.text).toBe('ঈদের নতুন গল্প')
    expect(api.requests.at(-1)?.body).toMatchObject({
      rollbackPointId: expect.stringMatching(/^crp_[a-f0-9]{32}$/),
    })
  })

  it('hydrates the latest Agent rollback target after reload and rolls it back', async () => {
    const api = new FoundationApiHarness()
    const firstPort = createFoundationCompositionCommandPort({ fetcher: api.fetch })
    const initial = await firstPort.load(SCOPE)
    const proposal = await volumeProposal(initial, 0.45, [], 'agent')
    const applied = await firstPort.applyLocal({
      proposal,
      actor: OWNER,
      acknowledgement: {
        fingerprint: proposal.fingerprint,
        scope: proposal.scope,
        expectedVersion: proposal.expectedVersion,
        acknowledgedByUserId: OWNER.userId,
        acknowledgedByRole: 'owner',
        acknowledgedAt: '2026-07-26T06:00:00.000Z',
      },
    })

    const reloadedPort = createFoundationCompositionCommandPort({
      fetcher: api.fetch,
    })
    const reloaded = await reloadedPort.load(SCOPE)
    expect(reloaded).toMatchObject({
      latestAgentBatchId: applied.batchId,
      canRollbackLatestAgentBatch: true,
    })

    const rolledBack = await reloadedPort.rollback({
      scope: SCOPE,
      expectedVersion: reloaded.version,
      expectedConcurrencyToken: reloaded.concurrencyToken,
      actor: OWNER,
      batchId: reloaded.latestAgentBatchId!,
    })
    expect(rolledBack.status).toBe('rolled_back')
    expect(api.requests.at(-1)?.body).toMatchObject({
      rollbackPointId: `crp_${applied.batchId.slice(4)}`,
    })
  })

  it('fails closed on brand and authenticated-role drift', async () => {
    const brandApi = new FoundationApiHarness()
    const brandPort = createFoundationCompositionCommandPort({
      fetcher: brandApi.fetch,
    })
    await expect(brandPort.load({
      ...SCOPE,
      brandProfileId: 'brand-other',
    })).rejects.toMatchObject({ code: 'scope_mismatch' })

    const roleApi = new FoundationApiHarness()
    const rolePort = createFoundationCompositionCommandPort({
      fetcher: roleApi.fetch,
    })
    const snapshot = await rolePort.load(SCOPE)
    const proposal = await volumeProposal(snapshot, 0.6)
    roleApi.setRole('reviewer')
    await expect(rolePort.validateLocal({ proposal, actor: OWNER })).resolves.toMatchObject({
      ok: false,
      code: 'role_forbidden',
    })

    const requestsBeforeForgedActor = roleApi.requests.length
    await expect(rolePort.validateLocal({
      proposal,
      actor: { userId: 'creator-1', name: 'Creator', role: 'creator' },
    })).resolves.toMatchObject({
      ok: false,
      code: 'role_forbidden',
    })
    expect(roleApi.requests).toHaveLength(requestsBeforeForgedActor)
  })

  it('reports offline/network failure without mutating local or Foundation state', async () => {
    const api = new FoundationApiHarness()
    api.setOffline(true)
    const port = createFoundationCompositionCommandPort({ fetcher: api.fetch })
    await expect(port.load(SCOPE)).rejects.toMatchObject({
      code: 'network_unavailable',
      status: 0,
    })
    expect(api.snapshot().currentVersion).toBe(1)

    api.setOffline(false)
    const snapshot = await port.load(SCOPE)
    const proposal = await volumeProposal(snapshot, 0.2)
    api.setOffline(true)
    await expect(port.applyLocal({ proposal, actor: OWNER })).rejects.toMatchObject({
      code: 'network_unavailable',
    })
    expect(api.snapshot().currentVersion).toBe(1)
  })

  it('fails closed on a malformed Foundation document response', async () => {
    const api = new FoundationApiHarness()
    const malformed = api.snapshot()
    ;(malformed.document.tracks as unknown[]) = [null]
    const port = createFoundationCompositionCommandPort({
      fetcher: async () => Response.json({ composition: malformed }),
    })

    await expect(port.load(SCOPE)).rejects.toMatchObject({
      code: 'invalid_foundation_response',
      status: 502,
    })
  })

  it('never sends paid/provider/render/voice/publish actions through local apply', async () => {
    const api = new FoundationApiHarness()
    const port = createFoundationCompositionCommandPort({ fetcher: api.fetch })
    const snapshot = await port.load(SCOPE)
    const pendingActions: EditorPendingAction[] = [{
      id: 'pending-paid',
      kind: 'paid_generation',
      label: 'Generate video',
      targetIds: [],
      requiredRole: 'owner',
      state: 'requires_separate_confirmation',
      blockedReason: null,
      provider: {
        engineId: 'xai_imagine',
        model: 'grok-imagine-video',
        enabled: true,
        payloadDigest: 'paid-payload',
      },
      voice: null,
      destination: null,
      estimatedCostBdt: 75,
      maxCostBdt: 100,
    }, {
      id: 'pending-publish',
      kind: 'external_publish',
      label: 'Publish to Meta',
      targetIds: [],
      requiredRole: 'owner',
      state: 'blocked',
      blockedReason: 'external_effect_not_allowed',
      provider: null,
      voice: null,
      destination: 'meta',
      estimatedCostBdt: 0,
      maxCostBdt: 0,
    }]
    const proposal = await volumeProposal(snapshot, 0.45, pendingActions)
    const receipt = await port.applyLocal({ proposal, actor: OWNER })

    expect(receipt.pendingActionIds).toEqual(['pending-paid', 'pending-publish'])
    const mutationRequests = api.requests.filter((entry) => entry.method === 'POST')
    expect(mutationRequests.every((entry) =>
      entry.pathname.includes('/compositions/composition-1/'),
    )).toBe(true)
    const serializedBodies = JSON.stringify(mutationRequests.map((entry) => entry.body))
    expect(serializedBodies).not.toMatch(
      /paid_generation|external_publish|provider|render|voice|destination|payloadDigest/,
    )

    const externalOnly = await createOperationProposal({
      origin: 'human',
      snapshot: receipt.snapshot,
      actor: OWNER,
      instruction: 'Publish externally',
      normalizedInstruction: 'publish externally',
      operations: [],
      pendingActions: [pendingActions[1]],
      requiresClarification: true,
    })
    const before = api.requests.length
    await expect(port.validateLocal({
      proposal: externalOnly,
      actor: OWNER,
    })).resolves.toMatchObject({
      ok: false,
      code: 'clarification_required',
    })
    expect(api.requests).toHaveLength(before)
  })
})
