import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  compileCreativeAgentInstruction,
  type EditorActor,
} from '@/lib/creative-studio/editor-agent'
import { createEditorFixtureSnapshot } from '@/lib/creative-studio/editor-agent/__fixtures__/editor-snapshot'

const OWNER: EditorActor = {
  userId: 'owner-1',
  name: 'Owner',
  role: 'owner',
}

const mediaSource = readFileSync(
  new URL('../EditorMediaPanel.tsx', import.meta.url),
  'utf8',
)
const stageSource = readFileSync(
  new URL('../EditorStage.tsx', import.meta.url),
  'utf8',
)
const timelineSource = readFileSync(
  new URL('../EditorTimeline.tsx', import.meta.url),
  'utf8',
)
const agentSource = readFileSync(
  new URL('../CreativeAgentPanel.tsx', import.meta.url),
  'utf8',
)
const workbenchSource = readFileSync(
  new URL('../EditorWorkbench.tsx', import.meta.url),
  'utf8',
)

describe('Project Editor presentation contract', () => {
  it('covers project/media/library tools, the stage, and all synchronized track kinds', () => {
    const snapshot = createEditorFixtureSnapshot()

    expect(snapshot.tracks.map((track) => track.kind)).toEqual([
      'video',
      'overlay',
      'caption',
      'voice',
      'music',
      'sfx',
    ])
    for (const tool of [
      'project',
      'media',
      'library',
      'video',
      'image',
      'caption',
      'voice',
      'music',
      'sfx',
    ]) {
      expect(mediaSource).toContain(`id: '${tool}'`)
    }
    expect(stageSource).toContain('Composition stage and player')
    expect(stageSource).toContain('activeCaption')
    expect(stageSource).toContain('activeOverlays')
    expect(stageSource).toContain('Preview not hydrated')
    expect(timelineSource).toContain('Synchronized multi-track timeline')
    expect(timelineSource).toContain('snapshot.tracks.map')
    expect(timelineSource).toContain('Not complete')
  })

  it('presents blocked provider work as blocked, never as confirmable', async () => {
    const snapshot = createEditorFixtureSnapshot()
    const proposal = await compileCreativeAgentInstruction(
      'Generate a new video clip.',
      {
        snapshot,
        actor: OWNER,
        selectedTrackId: 'track-video',
        selectedClipId: 'clip-hero',
        playheadSec: 2,
        firstBeatSec: 1.2,
        generationProvider: null,
        voice: null,
      },
    )

    expect(proposal.pendingActions[0]).toMatchObject({
      state: 'blocked',
      blockedReason: 'provider_unavailable',
    })
    expect(agentSource).toContain("provider_unavailable: 'Provider unavailable · blocked'")
    expect(agentSource).toContain("action.state === 'blocked'")
    expect(agentSource).toContain('Never in local apply')
  })

  it('exposes inspector, Agent, review and activity with versioned local controls', () => {
    for (const tab of ['inspector', 'agent', 'review', 'activity']) {
      expect(workbenchSource).toContain(`id: '${tab}'`)
    }
    expect(workbenchSource).toContain('role="tablist"')
    expect(workbenchSource).toContain('aria-controls="editor-workbench-panel"')
    expect(workbenchSource).toContain('role="tabpanel"')
    expect(workbenchSource).toContain('Expected composition v{snapshot.version}')
    expect(workbenchSource).toContain('Provenance & A+B truth')
    expect(workbenchSource).toContain('APPEND-ONLY ACTIVITY')
  })
})
