import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const nativeEditor = readFileSync(
  join(process.cwd(), 'ios/App/App/CreativeStudioCompositionEditorSwiftUI.swift'),
  'utf8',
)
const agentPlanRoute = readFileSync(
  join(
    process.cwd(),
    'src/app/api/assistant/creative-studio/compositions/[id]/agent-plan/route.ts',
  ),
  'utf8',
)

describe('native Foundation composition editor contract', () => {
  it('exposes a complete scope-bound native screen and loads the canonical composition view', () => {
    expect(nativeEditor).toContain('struct CreativeStudioCompositionEditorScreen: View')
    expect(nativeEditor).toContain(
      'init(brandID: String, projectID: String, compositionID: String, role: String)',
    )
    expect(nativeEditor).toContain(
      '/api/assistant/creative-studio/compositions/\\(compositionID)',
    )
    expect(nativeEditor).toContain('query: ["brandProfileId": brandID]')
    expect(nativeEditor).toContain('value.id == compositionID')
    expect(nativeEditor).toContain('value.brandProfileId == brandID')
    expect(nativeEditor).toContain('value.projectId == projectID')
    expect(nativeEditor).toContain(
      'value.currentVersion == value.document.documentVersion',
    )
    expect(nativeEditor).toContain(
      'value.concurrencyToken == value.document.concurrencyToken',
    )
    expect(nativeEditor).toContain('sectionTitle("Canvas"')
    expect(nativeEditor).toContain('canvas.resolution.width')
    expect(nativeEditor).toContain('canvas.safeZones')
    // Web EditorTimeline parity: proportional lanes + transport replaced the clip chip list.
    expect(nativeEditor).toContain('sectionTitle("Timeline"')
    expect(nativeEditor).toContain('model.reviewSplit(at: model.playheadSec)')
    expect(nativeEditor).toContain('Clip inspector')
  })

  it('server-validates before exposing a separate explicit apply confirmation', () => {
    const validateOffset = nativeEditor.indexOf('/operations/validate')
    const pendingOffset = nativeEditor.indexOf(
      'pendingMutation = CSCEPendingMutation(',
    )
    const applyOffset = nativeEditor.indexOf('/operations/apply')

    expect(validateOffset).toBeGreaterThan(-1)
    expect(pendingOffset).toBeGreaterThan(validateOffset)
    expect(applyOffset).toBeGreaterThan(pendingOffset)
    expect(nativeEditor).toContain('.alert("Validated edit apply করবেন?"')
    expect(nativeEditor).toContain('Button("Confirm ৳0 Apply")')
    expect(nativeEditor).toContain(
      'pending.expectedVersion == current.currentVersion',
    )
    expect(nativeEditor).toContain(
      'pending.expectedConcurrencyToken == current.concurrencyToken',
    )
    expect(nativeEditor).toContain(
      'receipt.batch.requestFingerprint == pending.requestFingerprint',
    )
  })

  it('maps every production reversible edit class to Foundation operations', () => {
    for (const editorOperation of [
      'caption.text.set',
      'caption.timing.set',
      'clip.trim',
      'clip.split',
      'clip.move',
      'node.transform.set',
      'track.volume.set',
    ]) {
      expect(nativeEditor).toContain(editorOperation)
    }
    for (const foundationOperation of [
      'node.replace',
      'clip.replace',
      'clip.remove',
      'clip.insert',
      'track.replace',
    ]) {
      expect(nativeEditor).toContain(foundationOperation)
    }
    expect(nativeEditor).toContain('Shared caption node safely edit করা যায় না।')
    expect(nativeEditor).toContain('guard !track.locked')
  })

  it('bounds user-entered seconds before converting them to Int', () => {
    const helperOffset = nativeEditor.indexOf(
      'private func milliseconds(_ seconds: Double, label: String) throws -> Int',
    )
    const upperBoundOffset = nativeEditor.indexOf(
      'seconds >= 0, seconds <= 86_400',
      helperOffset,
    )
    const conversionOffset = nativeEditor.indexOf(
      'Int((seconds * 1_000).rounded())',
      helperOffset,
    )

    expect(helperOffset).toBeGreaterThan(-1)
    expect(upperBoundOffset).toBeGreaterThan(helperOffset)
    expect(conversionOffset).toBeGreaterThan(upperBoundOffset)
  })

  it('uses durable server history with exact CAS data for undo, redo and Agent rollback', () => {
    expect(nativeEditor).toContain('composition.history.currentUndoBatchId')
    expect(nativeEditor).toContain('composition.history.currentRedoBatchId')
    expect(nativeEditor).toContain('receipt.batch.targetBatchId == target')
    expect(nativeEditor).toContain(
      'composition.history.rollbackPoints.first(where: { $0.batchId == batchID })',
    )
    expect(nativeEditor).toContain('expectedVersion: composition.currentVersion')
    expect(nativeEditor).toContain(
      'expectedConcurrencyToken: composition.concurrencyToken',
    )
    expect(nativeEditor).toContain('/\\(kind)"')
    expect(nativeEditor).toContain('/rollback"')
    expect(nativeEditor).toContain('self.composition = try await fetchComposition()')
  })

  it('keeps reviewer/read-only mutations disabled and Agent apply owner-only', () => {
    expect(nativeEditor).toContain('!composition.readonly')
    expect(nativeEditor).toContain('["owner", "creator"].contains(effectiveRole)')
    expect(nativeEditor).toContain('effectiveRole == "owner"')
    expect(nativeEditor).toContain('$0.effect == "local_reversible"')
    expect(nativeEditor).toContain('$0.estimatedCostBdt == 0')
    expect(nativeEditor).toContain('Exact fingerprint reviewed')
    expect(nativeEditor).toContain('editor-agent-apply-\\(digest)')
    expect(nativeEditor).toContain('Raw Foundation operations')
    expect(nativeEditor).toContain('operation.operationType')
    expect(nativeEditor).toContain('plan.proposal.pendingActions')
    expect(nativeEditor).toContain('plan.proposal.warnings')
    expect(nativeEditor).toContain('plan.proposal.fingerprint')
    expect(nativeEditor).toContain('Text(plan.proposal.fingerprint)')
    expect(nativeEditor).toContain('pending.agentFingerprint.map')
  })

  it('matches the server Agent instruction UTF-16 boundary before requesting a plan', () => {
    expect(agentPlanRoute).toContain('.max(4_000)')
    expect(nativeEditor).toContain('agentInstructionValidationMessage')
    expect(nativeEditor).toContain('.utf16')
    expect(nativeEditor).toContain('if units > 4_000')
    expect(nativeEditor).toContain(
      '.disabled(model.actionBusy || model.agentInstructionValidationMessage != nil)',
    )
  })
})

describe('native deterministic Agent plan route', () => {
  it('binds auth and brand/project/composition scope before compiling', () => {
    expect(agentPlanRoute).toContain("authorizeCompositionRoute(req, 'plan')")
    expect(agentPlanRoute).toContain('getCreativeComposition(')
    expect(agentPlanRoute).toContain('composition.projectId !== input.projectId')
    expect(agentPlanRoute).toContain("error: 'project_scope_mismatch'")
    expect(agentPlanRoute).toContain('projectFoundationCompositionToEditor(')
    expect(agentPlanRoute).toContain('compileCreativeAgentInstruction(')
    expect(agentPlanRoute).toContain('compileFoundationEditorOperations(')
    expect(agentPlanRoute).toContain('role: composition.accessRole')
  })

  it('returns raw operations and high-level proposal without execution or providers', () => {
    expect(agentPlanRoute).toContain('generationProvider: null')
    expect(agentPlanRoute).toContain('voice: null')
    expect(agentPlanRoute).toContain('proposal,')
    expect(agentPlanRoute).toContain('operations,')
    expect(agentPlanRoute).toContain('executed: false')
    expect(agentPlanRoute).toContain('zeroCostOnly: true')
    expect(agentPlanRoute).not.toContain('creativeCompositionCommandService')
    expect(agentPlanRoute).not.toContain('/operations/apply')
    expect(agentPlanRoute).not.toContain('queueCreative')
    expect(agentPlanRoute).not.toContain('renderCreative')
    expect(agentPlanRoute).not.toContain('publishCreative')
  })
})
