import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const nativeStudio = readFileSync(
  join(process.cwd(), 'ios/App/App/CreativeStudioSwiftUI.swift'),
  'utf8',
)
const nativeWorkspace = readFileSync(
  join(process.cwd(), 'ios/App/App/CreativeStudioV4WorkspaceSwiftUI.swift'),
  'utf8',
)
const nativeMaskRepair = readFileSync(
  join(process.cwd(), 'ios/App/App/CSMaskRepairSwiftUI.swift'),
  'utf8',
)
const galleryRoute = readFileSync(
  join(process.cwd(), 'src/app/api/assistant/creative-studio/gallery/route.ts'),
  'utf8',
)

describe('iOS current-production Creative Studio parity', () => {
  it('keeps the existing native six-tab design and adds the workspace as a sheet', () => {
    expect(nativeStudio).toContain('case home, create, gallery, video, audio, library')
    expect(nativeStudio).toContain('CSV4WorkspaceScreen(seedProject: vm.activeProject)')
    expect(nativeStudio).toContain('V4 Production Workspace')
  })

  it('covers the production project, review, campaign, voice and operations APIs', () => {
    for (const route of [
      '/api/assistant/creative-studio/brands',
      '/api/assistant/creative-studio/projects',
      '/api/assistant/creative-studio/recipes',
      '/api/assistant/creative-studio/compositions',
      '/api/assistant/creative-studio/reviews',
      '/api/assistant/creative-studio/campaign-packs',
      '/api/assistant/creative-studio/voices',
      '/api/assistant/creative-studio/health',
      '/api/assistant/creative-studio/retention',
      '/api/assistant/creative-studio/lifecycle',
      '/api/assistant/creative-studio/performance',
      '/api/assistant/creative-studio/roles',
    ]) {
      expect(nativeWorkspace).toContain(route)
    }
  })

  it('previews campaign cost before an explicitly confirmed queue', () => {
    expect(nativeWorkspace).toContain('let intent = "preview"')
    expect(nativeWorkspace).toContain('let intent = "queue"')
    expect(nativeWorkspace).toContain('confirmedCostUsd: preview.estimatedCostUsd')
    expect(nativeWorkspace).toContain('.alert("Campaign Pack queue করবেন?"')
  })

  it('uses production estimate-confirm gates for audio and consented voice versions', () => {
    expect(nativeStudio).toContain('pendingAudioEstimate')
    expect(nativeStudio).toContain('estimateVoiceClone(samplePaths:')
    expect(nativeStudio).toContain('/api/assistant/creative-studio/voices')
    expect(nativeStudio).toContain('estimateBody["intent"] = AnyEncodable("estimate")')
    expect(nativeStudio).toContain('body["intent"] = AnyEncodable("queue")')
    expect(nativeStudio).toContain('Confirm & Queue')
    expect(nativeStudio).toContain('"usageContext": AnyEncodable("owner_studio")')
  })

  it('exposes canonical lifecycle filters in the native Gallery', () => {
    expect(nativeStudio).toContain('("Approved", "approved")')
    expect(nativeStudio).toContain('("Review", "review")')
    expect(nativeStudio).toContain('("Archived", "archived")')
    expect(nativeStudio).toContain('projectAssetId')
    expect(nativeStudio).toContain('assetVersionId')
    expect(nativeStudio).toContain('gallerySearch')
    expect(nativeStudio).toContain('galleryProvider')
    expect(nativeStudio).toContain('galleryAspect')
    expect(nativeStudio).toContain('galleryDensity')
    expect(nativeStudio).toContain('$0.reviewState == "approved"')
    expect(nativeStudio).toContain('$0.reviewState == "changes_requested"')
    expect(nativeStudio).toContain('$0.archived == true')
  })

  it('preserves project scope and sends Gallery search to the server', () => {
    expect(nativeStudio).toContain('let priorProjectID = activeProject?.id')
    expect(nativeStudio).toContain('writable.first { $0.id == priorProjectID }')
    expect(nativeStudio).toContain('query["q"] = search')
    expect(nativeStudio).toContain('.onSubmit { Task { await vm.refreshGallery() } }')
    expect(nativeStudio).toContain('query["order"] = gallerySort')
    expect(nativeWorkspace).toContain('model.invalidateCampaignPreview()')
  })

  it('returns canonical lifecycle and aspect metadata for native filters', () => {
    expect(galleryRoute).toContain('reviewState: String(asset.reviewState).toLowerCase()')
    expect(galleryRoute).toContain('archived: canonical?.archived ?? false')
    expect(galleryRoute).toContain('originalVariant?.requestedAspectRatio')
    expect(galleryRoute).toContain("typeof payload.aspectRatio === 'string'")
    expect(galleryRoute).toContain("const oldestFirst = req.nextUrl.searchParams.get('order') === 'oldest'")
  })

  it('keeps precision mask repair behind a signed estimate and explicit confirmation', () => {
    expect(nativeStudio).toContain('/api/assistant/creative-studio/mask-upload')
    expect(nativeStudio).toContain('payload.vtonEngine = "fal_flux_fill"')
    expect(nativeStudio).not.toContain('payload.provider = "fashn"\n        payload.vtonEngine = "fal_flux_fill"')
    expect(nativeStudio).toContain('payload.intent = "estimate"')
    expect(nativeStudio).toContain('payload.intent = "confirm"')
    expect(nativeMaskRepair).toContain('Upload mask & get exact estimate')
    expect(nativeMaskRepair).toContain('.alert("Signed estimate নিশ্চিত করবেন?"')
    expect(nativeMaskRepair).toContain('Confirm & Queue')
    expect(nativeMaskRepair).toContain('let fittedWidth = min(available, fittedHeight * ratio)')
  })

  it('supports owner retention controls, lifecycle job controls and performance attribution', () => {
    expect(nativeWorkspace).toContain('"PATCH", "/api/assistant/creative-studio/retention"')
    expect(nativeWorkspace).toContain('controlLifecycle(')
    expect(nativeWorkspace).toContain('Performance & attribution')
    expect(nativeWorkspace).toContain('external publish')
  })

  it('keeps resolved project scope and voice readiness synchronized with the main studio', () => {
    expect(nativeWorkspace).toContain('syncSelectedProject()')
    expect(nativeWorkspace).toContain('CSV4CreateProjectSheet(model: model) { syncSelectedProject() }')
    expect(nativeWorkspace).toContain('version.providerReady && version.status == "ready"')
  })

  it('keeps campaign options and draft selection aligned with the server manifest', () => {
    expect(nativeWorkspace).toContain('model.invalidateCampaignPreview()')
    expect(nativeWorkspace).toContain('guard revision == campaignPreviewRevision')
    expect(nativeWorkspace).toContain('let action = "select_draft"')
    expect(nativeWorkspace).toContain('func selectCampaignDraft(')
    expect(nativeWorkspace).toContain('এই draft নিন')
  })

  it('protects mask repair from unavailable sources and preserves brush taps', () => {
    expect(nativeStudio).toContain('item.archivedToDrive != true')
    expect(nativeMaskRepair).toContain('if stroke.count == 1')
    expect(nativeMaskRepair).toContain('cg.fillEllipse')
  })
})
