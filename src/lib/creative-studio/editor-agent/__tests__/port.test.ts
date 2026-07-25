import { describe, expect, it } from 'vitest'
import {
  compileCreativeAgentInstruction,
  createEditorFixtureSnapshot,
  createInMemoryCompositionCommandPort,
  createOperationProposal,
  type AgentPlanningContext,
  type EditorActor,
  type EditorTrackVolumeOperation,
  type OwnerPlanAcknowledgement,
} from '@/lib/creative-studio/editor-agent'

const OWNER: EditorActor = { userId: 'owner-1', name: 'Owner', role: 'owner' }

function planningContext(): AgentPlanningContext {
  return {
    snapshot: createEditorFixtureSnapshot(),
    actor: OWNER,
    selectedTrackId: 'track-video',
    selectedClipId: 'clip-hero',
    playheadSec: 2.8,
    firstBeatSec: 1.2,
    generationProvider: null,
    voice: null,
  }
}

function acknowledgement(
  proposal: Awaited<ReturnType<typeof compileCreativeAgentInstruction>>,
): OwnerPlanAcknowledgement {
  return {
    fingerprint: proposal.fingerprint,
    scope: proposal.scope,
    expectedVersion: proposal.expectedVersion,
    acknowledgedByUserId: OWNER.userId,
    acknowledgedByRole: 'owner',
    acknowledgedAt: '2026-07-26T00:00:00.000Z',
  }
}

describe('temporary CompositionCommandPort adapter', () => {
  it('applies an acknowledged local batch and appends version-derived audit IDs', async () => {
    const context = planningContext()
    const proposal = await compileCreativeAgentInstruction(
      'Move caption to first beat and lower music to 12%.',
      context,
    )
    const port = createInMemoryCompositionCommandPort(context.snapshot)
    const receipt = await port.applyLocal({
      proposal,
      acknowledgement: acknowledgement(proposal),
      actor: OWNER,
    })

    expect(receipt.status).toBe('applied')
    expect(receipt.snapshot.version).toBe(13)
    expect(receipt.auditId).toMatch(/^AUD-13-[A-F0-9]{12}$/)
    expect(receipt.operationIds).toEqual(proposal.operations.map((operation) => operation.id))
    expect(receipt.pendingActionIds).toEqual([])
    expect(receipt.snapshot.review.publishReady).toBe(false)
    expect(receipt.snapshot.activity.at(-1)).toMatchObject({
      id: receipt.auditId,
      kind: 'edit',
      version: 13,
    })
  })

  it('supports undo, redo and rollback as new audited versions', async () => {
    const context = planningContext()
    const proposal = await compileCreativeAgentInstruction(
      'Move caption to first beat and lower music to 12%.',
      context,
    )
    const port = createInMemoryCompositionCommandPort(context.snapshot)
    const applied = await port.applyLocal({
      proposal,
      acknowledgement: acknowledgement(proposal),
      actor: OWNER,
    })
    const undone = await port.undo({
      scope: applied.snapshot.scope,
      expectedVersion: applied.snapshot.version,
      expectedConcurrencyToken: applied.snapshot.concurrencyToken,
      actor: OWNER,
    })
    const redone = await port.redo({
      scope: undone.snapshot.scope,
      expectedVersion: undone.snapshot.version,
      expectedConcurrencyToken: undone.snapshot.concurrencyToken,
      actor: OWNER,
    })
    const rolledBack = await port.rollback({
      scope: redone.snapshot.scope,
      expectedVersion: redone.snapshot.version,
      expectedConcurrencyToken: redone.snapshot.concurrencyToken,
      actor: OWNER,
      batchId: applied.batchId,
    })

    expect([
      applied.snapshot.version,
      undone.snapshot.version,
      redone.snapshot.version,
      rolledBack.snapshot.version,
    ]).toEqual([13, 14, 15, 16])
    expect(undone.status).toBe('undone')
    expect(redone.status).toBe('redone')
    expect(rolledBack.status).toBe('rolled_back')
    expect(
      rolledBack.snapshot.tracks
        .find((track) => track.id === 'track-music')
        ?.clips[0].volume,
    ).toBe(0.18)
    expect(rolledBack.snapshot.activity.at(-1)?.kind).toBe('rollback')
  })

  it('allows direct human local operations but never a paid operation shape', async () => {
    const snapshot = createEditorFixtureSnapshot()
    const operation: EditorTrackVolumeOperation = {
      id: 'op-human-volume',
      label: 'Lower music',
      kind: 'track.volume.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: 'track-music', clipId: 'music-eid-pulse' },
      before: 0.18,
      after: 0.1,
    }
    const proposal = await createOperationProposal({
      origin: 'human',
      snapshot,
      actor: OWNER,
      instruction: 'Set music volume to 10%',
      normalizedInstruction: 'set music volume to 10%',
      operations: [operation],
    })
    const port = createInMemoryCompositionCommandPort(snapshot)
    const receipt = await port.applyLocal({ proposal, actor: OWNER })

    expect(receipt.snapshot.tracks[4].clips[0].volume).toBe(0.1)
  })

  it('rejects a stale or deleted target even at the current version', async () => {
    const snapshot = createEditorFixtureSnapshot()
    const operation: EditorTrackVolumeOperation = {
      id: 'op-missing-target',
      label: 'Lower missing music',
      kind: 'track.volume.set',
      effect: 'local_reversible',
      estimatedCostBdt: 0,
      requiredRole: 'creator',
      target: { trackId: 'track-music', clipId: 'deleted-clip' },
      before: 0.18,
      after: 0.1,
    }
    const proposal = await createOperationProposal({
      origin: 'human',
      snapshot,
      actor: OWNER,
      instruction: 'Set missing music volume',
      normalizedInstruction: 'set missing music volume',
      operations: [operation],
    })
    const port = createInMemoryCompositionCommandPort(snapshot)

    await expect(port.validateLocal({ proposal, actor: OWNER })).resolves.toMatchObject({
      ok: false,
      code: 'stale_target',
    })
  })

  it('preserves A+B artifact and reference lineage across local edits', async () => {
    const snapshot = createEditorFixtureSnapshot()
    const artifactBefore = structuredClone(snapshot.assets[0].artifact)
    const referencesBefore = structuredClone(snapshot.assets[0].referenceContract)
    const proposal = await compileCreativeAgentInstruction(
      'Move caption to first beat.',
      planningContext(),
    )
    const port = createInMemoryCompositionCommandPort(snapshot)
    const receipt = await port.applyLocal({
      proposal,
      acknowledgement: acknowledgement(proposal),
      actor: OWNER,
    })

    expect(receipt.snapshot.assets[0].artifact).toEqual(artifactBefore)
    expect(receipt.snapshot.assets[0].referenceContract).toEqual(referencesBefore)
    expect(receipt.snapshot.assets[0].artifact).toMatchObject({
      requestedTier: '1k',
      width: 1080,
      height: 1350,
      validation: 'verified',
    })
  })
})
