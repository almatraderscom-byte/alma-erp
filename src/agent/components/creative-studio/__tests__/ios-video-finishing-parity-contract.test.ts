import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const native = read('ios/App/App/CreativeStudioSwiftUI.swift')
const serverContract = read('src/lib/creative-studio/video-edit-contract.ts')
const serverRoute = read('src/app/api/assistant/creative-studio/video/finish/route.ts')
const projectsRoute = read('src/app/api/assistant/creative-studio/projects/route.ts')

describe('iOS production video-finishing parity', () => {
  it('encodes every field in the versioned server edit contract', () => {
    for (const field of [
      'version',
      'sourceDurationSec',
      'preserveVisualSource',
      'segments',
      'crop',
      'volumes',
      'captionPlacement',
      'transcript',
      'cover',
      'rerender',
    ]) {
      expect(serverContract).toContain(`${field}:`)
      expect(native).toContain(`var ${field}:`)
    }
    expect(native).toContain('struct CSVideoEditContract: Codable')
    expect(native).toContain('CSVideoEditContract.fresh(durationSec:')
  })

  it('uses the canonical owner-scoped source and partial-edit API', () => {
    expect(native).toContain('item.projectId == project.id')
    expect(native).toContain('item.brandProfileId == brandProfileId')
    expect(native).toContain('let projectAssetId = item.projectAssetId')
    expect(native).toContain('func fetchVideoEditSource(_ item: CSGalleryItem)')
    expect(native).toContain('func partiallyFinishVideo(_ item: CSGalleryItem, contract: CSVideoEditContract)')
    expect(native).toContain('let mode = "partial_edit"')
    for (const key of ['pendingActionId', 'brandProfileId', 'projectId', 'projectAssetId']) {
      expect(native).toContain(`"${key}"`)
    }
    expect(serverRoute).toContain("if (body.mode === 'partial_edit')")
    expect(serverRoute).toContain('costBdt: 0')
  })

  it('fails video finishing closed unless the existing owner-only project route verified the scope', () => {
    expect(projectsRoute).toContain('if (!isSystemOwner(token))')
    expect(native).toContain('private var verifiedVideoOwnerScope: VideoOwnerScope?')
    expect(native).toContain('verifiedVideoOwnerScope = nil')
    expect(native).toContain('func canFinishVideo(_ item: CSGalleryItem) -> Bool')
    expect(native).toContain('verifiedVideoOwnerScope == VideoOwnerScope(')
    expect(native).toContain('!item.isVideo || vm.canFinishVideo(item)')
  })

  it('exposes Timeline and Templates without changing the glass host', () => {
    expect(native).toContain('case timeline, templates')
    expect(native).toContain('CSVideoTimelineFinishPanel(item: item, vm: vm, onDone: onDone)')
    expect(native).toContain('CSMotionTemplateFinishPanel(item: item, vm: vm, onDone: onDone)')
    expect(native).toContain('.padding(14).csGlass(scheme, corner: 18)')
  })

  it('covers trim, crop, audio, captions, transcript, cover and selected tracks', () => {
    for (const marker of [
      'Ordered trim segments',
      'Crop · focus · safe zone',
      'Track volume',
      'Caption + cover',
      'Transcript + timing',
      'toggleRenderTrack(track)',
      'moveSegment(segment.id, by:',
    ]) expect(native).toContain(marker)
    expect(native).toContain('contract.validationMessage')
    expect(native).toContain('বাছাই করা track render করুন · ৳0')
    expect(native).toContain('মূল visual source overwrite বা regenerate হবে না')
  })

  it('uses stable row IDs for bindings, deletes and reordering', () => {
    expect(native).toContain('ForEach(contract.segments) { segment in')
    expect(native).toContain('segmentBinding(segment.id, fallback: segment)')
    expect(native).toContain('removeSegment(segment.id)')
    expect(native).toContain('ForEach(contract.transcript) { cue in')
    expect(native).toContain('cueBinding(cue.id, fallback: cue)')
    expect(native).toContain('removeCue(cue.id)')
    expect(native).toContain('editorContract.ensureStableEditorIDs()')
    expect(native).toContain('Set(transcript.map(\\.id)).count == transcript.count')
    expect(native).not.toContain('ForEach(contract.segments.indices')
    expect(native).not.toContain('ForEach(contract.transcript.indices')
  })

  it('guards both POSTs immediately and cancels bounded polls on disappearance', () => {
    expect(native.match(/guard !queueing, !working, submitTask == nil/g)).toHaveLength(2)
    expect(native.match(/queueing = true \/\/ Synchronous/g)).toHaveLength(2)
    expect(native.match(/\.onDisappear \{ cancelOperations\(\) \}/g)).toHaveLength(2)
    expect(native.match(/for _ in 0\.\.<225/g)).toHaveLength(2)
    expect(native).toContain('guard !Task.isCancelled, lifecycleToken == token else { return }')
    expect(native).not.toContain('while working')
  })

  it('does not overstate voiceover cue execution', () => {
    expect(native).toContain('Voice line timing metadata থাকে')
    expect(native).toContain('existing voice track volume অনুযায়ী mix হয়')
  })
})
