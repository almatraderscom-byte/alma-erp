import { describe, expect, it } from 'vitest'
import {
  compileCreativeAgentInstruction,
  type AgentPlanningContext,
  type EditorActor,
} from '@/lib/creative-studio/editor-agent'
import { createEditorFixtureSnapshot } from '@/lib/creative-studio/editor-agent/__fixtures__/editor-snapshot'

const OWNER: EditorActor = {
  userId: 'owner-1',
  name: 'Owner',
  role: 'owner',
}

function context(
  overrides: Partial<AgentPlanningContext> = {},
): AgentPlanningContext {
  return {
    snapshot: createEditorFixtureSnapshot(),
    actor: OWNER,
    selectedTrackId: 'track-video',
    selectedClipId: 'clip-hero',
    playheadSec: 2.8,
    firstBeatSec: 1.2,
    generationProvider: {
      engineId: 'xai_imagine',
      model: 'grok-imagine-image-quality',
      enabled: true,
      estimatedCostBdt: 75,
      maxCostBdt: 100,
      payloadDigest: 'payload-video-v1',
    },
    voice: {
      versionId: 'voice-v3',
      active: true,
      consented: true,
      revoked: false,
      estimatedCostBdt: 24,
      maxCostBdt: 30,
      provider: {
        engineId: null,
        model: 'eleven-v3',
        enabled: true,
        estimatedCostBdt: 24,
        maxCostBdt: 30,
        payloadDigest: 'payload-voice-v3',
      },
    },
    ...overrides,
  }
}

describe('Creative Agent deterministic compiler', () => {
  it('compiles the approved mixed Bangla/English instruction into only three local edits', async () => {
    const proposal = await compileCreativeAgentInstruction(
      'Opening shotটা tighter করো, caption beat-এ আনো, voice-এর নিচে music কমাও। Paid বা publish কিছু কোরো না।',
      context(),
    )

    expect(proposal.operations.map((operation) => operation.kind)).toEqual([
      'caption.timing.set',
      'clip.trim',
      'track.volume.set',
    ])
    expect(proposal.operations.every((operation) => (
      operation.effect === 'local_reversible'
      && operation.estimatedCostBdt === 0
    ))).toBe(true)
    expect(proposal.pendingActions).toEqual([])
    expect(proposal.requiresClarification).toBe(false)
    expect(proposal.fingerprint).toMatch(/^csplan-v1-[a-f0-9]{64}$/)
  })

  it('compiles Bengali digits, caption timing, split and volume deterministically', async () => {
    const proposal = await compileCreativeAgentInstruction(
      'ক্যাপশন ১.২ সেকেন্ডে নাও, মিউজিক ১২% করো, ক্লিপ প্লেহেডে ভাগ করো।',
      context(),
    )

    expect(proposal.operations.map((operation) => operation.kind)).toEqual([
      'caption.timing.set',
      'clip.split',
      'track.volume.set',
    ])
    expect(proposal.operations.find((operation) => operation.kind === 'track.volume.set'))
      .toMatchObject({ before: 0.18, after: 0.12 })
  })

  it('supports caption text and transform proposals in both languages', async () => {
    const proposal = await compileCreativeAgentInstruction(
      'ক্যাপশন লিখো "ঈদের অফার আজই" এবং scale 110%',
      context({
        selectedTrackId: 'track-caption',
        selectedClipId: 'caption-primary',
      }),
    )

    expect(proposal.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'caption.text.set',
        before: 'ঈদের নতুন গল্প',
        after: 'ঈদের অফার আজই',
      }),
      expect.objectContaining({
        kind: 'node.transform.set',
        after: expect.objectContaining({ scale: 1.1 }),
      }),
    ]))
  })

  it('produces the same fingerprint and operation IDs for identical scope and input', async () => {
    const instruction = 'Tighten the opening and move caption to the first beat.'
    const first = await compileCreativeAgentInstruction(instruction, context())
    const second = await compileCreativeAgentInstruction(instruction, context())

    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.id).toBe(first.id)
    expect(second.operations.map((operation) => operation.id)).toEqual(
      first.operations.map((operation) => operation.id),
    )
  })

  it('binds a fingerprint to composition version, brand and project', async () => {
    const instruction = 'Move caption to the first beat.'
    const base = context()
    const first = await compileCreativeAgentInstruction(instruction, base)
    const nextVersion = {
      ...base.snapshot,
      version: base.snapshot.version + 1,
      concurrencyToken: 'fixture-v13',
    }
    const second = await compileCreativeAgentInstruction(instruction, {
      ...base,
      snapshot: nextVersion,
    })
    const anotherBrand = await compileCreativeAgentInstruction(instruction, {
      ...base,
      snapshot: {
        ...base.snapshot,
        scope: {
          ...base.snapshot.scope,
          brandProfileId: 'brand-alma-trading',
        },
      },
    })

    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(anotherBrand.fingerprint).not.toBe(first.fingerprint)
  })

  it('requests clarification instead of guessing an unavailable target', async () => {
    const snapshot = createEditorFixtureSnapshot()
    snapshot.tracks = snapshot.tracks.filter((track) => track.kind !== 'caption')
    const proposal = await compileCreativeAgentInstruction(
      'Move caption to the first beat.',
      context({ snapshot }),
    )

    expect(proposal.requiresClarification).toBe(true)
    expect(proposal.operations).toHaveLength(0)
    expect(proposal.warnings).toContainEqual(
      expect.objectContaining({ code: 'ambiguous_target' }),
    )
  })
})
