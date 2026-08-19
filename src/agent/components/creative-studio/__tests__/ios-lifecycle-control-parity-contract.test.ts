import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const nativeLifecycle = readFileSync(
  join(process.cwd(), 'ios/App/App/CreativeStudioLifecycleSwiftUI.swift'),
  'utf8',
)

describe('iOS exact Creative Studio Lifecycle control', () => {
  it('exposes one self-contained screen with optional exact review seeds', () => {
    expect(nativeLifecycle).toContain('struct CSV4LifecycleControlScreen: View')
    expect(nativeLifecycle).toContain('brandID: String')
    expect(nativeLifecycle).toContain('projectID: String')
    expect(nativeLifecycle).toContain('role: String')
    expect(nativeLifecycle).toContain('selectedReviewAssetID: String? = nil')
    expect(nativeLifecycle).toContain('selectedReviewVersionID: String? = nil')
  })

  it('hydrates the canonical review thread and resolves the exact composition/artifact pin', () => {
    expect(nativeLifecycle).toContain('/api/assistant/creative-studio/reviews')
    expect(nativeLifecycle).toContain('"compositionId": compositionID')
    expect(nativeLifecycle).toContain('"artifactVersionId": artifactVersionID')
    expect(nativeLifecycle).toContain('resolved.compositionId == compositionID')
    expect(nativeLifecycle).toContain('resolved.artifactVersionId == artifactVersionID')
    expect(nativeLifecycle).toContain('resolved.artifactId == assetID')
  })

  it('uses strict Owner lifecycle review plus canonical role transitions with immutable approval pins', () => {
    expect(nativeLifecycle).toContain('/api/assistant/creative-studio/lifecycle/review/')
    expect(nativeLifecycle).toContain(String.raw`/api/assistant/creative-studio/assets/\(assetID)/state`)
    expect(nativeLifecycle).toContain('thread.role == "owner"')
    expect(nativeLifecycle).toContain('case "approved": permitted = thread.capabilities.approve')
    expect(nativeLifecycle).toContain('case "changes_requested": permitted = thread.capabilities.requestChanges')
    expect(nativeLifecycle).toContain('case "revised": permitted = thread.capabilities.markRevised')
    expect(nativeLifecycle).toContain('compositionId: target == "approved" ? approvalPin?.compositionId : nil')
    expect(nativeLifecycle).toContain('compositionVersionId: target == "approved" ? approvalPin?.compositionVersionId : nil')
    expect(nativeLifecycle).toContain('target == "changes_requested" && cleanNote.isEmpty')
    expect(nativeLifecycle).not.toContain('let actorRole')
  })

  it('keeps comments and review history readable while exposing only the production comment action', () => {
    expect(nativeLifecycle).toContain('let comments: [Comment]')
    expect(nativeLifecycle).toContain('case role = "actorRole"')
    expect(nativeLifecycle).toContain('Text("Review history")')
    expect(nativeLifecycle).toContain('ForEach(review.events)')
    expect(nativeLifecycle).toContain('ForEach(review.comments)')
    expect(nativeLifecycle).toContain('guard thread.capabilities.comment')
    expect(nativeLifecycle).toContain('let intent = "comment"')
    expect(nativeLifecycle).toContain('let comment: String')
    expect(nativeLifecycle).toContain('"POST",\n                "/api/assistant/creative-studio/reviews"')
  })

  it('rejects stale review and rollout responses and locks their selectors during mutation', () => {
    expect(nativeLifecycle).toContain('let revision = selectionRevision')
    expect(nativeLifecycle).toContain('selectedAssetID == assetID')
    expect(nativeLifecycle).toContain('selectedCompositionID == compositionID')
    expect(nativeLifecycle).toContain('selectedItem?.currentVersionId == artifactVersionID')
    expect(nativeLifecycle).toContain('let revision = rolloutRevision')
    expect(nativeLifecycle).toContain('selectedFlag?.id == requestedFlagID')
    expect(
      nativeLifecycle.match(/\.disabled\(model\.loading \|\| model\.busy != nil\)/g)?.length,
    ).toBeGreaterThanOrEqual(3)
  })

  it('admits only fixed zero-cost local preview, render and export requests', () => {
    expect(nativeLifecycle).toContain('let renderProfile = "composition-manifest-v1"')
    expect(nativeLifecycle).toContain('let outputFormat = "json"')
    expect(nativeLifecycle).toContain('let rendererVersion = "composition-manifest-v1"')
    expect(nativeLifecycle).toContain('let effectClass = "zero_cost_local"')
    expect(nativeLifecycle).toContain('let estimatedCostBdt = 0')
    expect(nativeLifecycle).toContain('validateZeroCostPreview')
    expect(nativeLifecycle).toContain('validateZeroCostJob')
    expect(nativeLifecycle).toContain('৳0 local job queue করবেন?')
    expect(nativeLifecycle).toContain('Confirm & Queue')
  })

  it('lists and mutates only exact config-only rollout flags while live publish stays hard off', () => {
    expect(nativeLifecycle).toContain('/api/assistant/creative-studio/lifecycle/flags')
    expect(nativeLifecycle).toContain('dualReadEnabled: false')
    expect(nativeLifecycle).toContain('legacyFallbackEnabled: true')
    expect(nativeLifecycle).toContain('capability == .livePublish && enabling')
    expect(nativeLifecycle).toContain('Live publish এই zero-cost client থেকে enable করা যায় না')
    expect(nativeLifecycle).toContain('!response.execution.externalPublishAllowed')
  })

  it('keeps jobs scoped, owner-controlled and quarantines ambiguous cancellation truth in the UI', () => {
    expect(nativeLifecycle).toContain('$0.brandProfileId == brandID && $0.projectId == projectID')
    expect(nativeLifecycle).toContain('/api/assistant/creative-studio/lifecycle/\\(job.id)')
    expect(nativeLifecycle).toContain('"queued", "running"')
    expect(nativeLifecycle).toContain('job.status == "failed"')
    expect(nativeLifecycle).toContain('job.status == "needs_review"')
    expect(nativeLifecycle).toContain('Manual reconciliation required')
  })
})
