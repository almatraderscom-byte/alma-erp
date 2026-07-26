import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'src/agent/components/creative-studio-v3')
const source = (name: string) => readFileSync(join(root, name), 'utf8')
const routeSource = readFileSync(
  join(process.cwd(), 'src/app/agent/creative-studio/page.tsx'),
  'utf8',
)
const editorSource = readFileSync(
  join(process.cwd(), 'src/agent/components/creative-studio/editor/CreativeProjectEditor.tsx'),
  'utf8',
)
const stageSource = readFileSync(
  join(process.cwd(), 'src/agent/components/creative-studio/editor/EditorStage.tsx'),
  'utf8',
)
const workbenchSource = readFileSync(
  join(process.cwd(), 'src/agent/components/creative-studio/editor/EditorWorkbench.tsx'),
  'utf8',
)
const editorStyles = readFileSync(
  join(process.cwd(), 'src/agent/components/creative-studio/editor/ProjectEditor.module.css'),
  'utf8',
)

describe('Creative Studio V3 cross-stream Editor integration', () => {
  it('routes both Long-form and selected Projects through real composition resolution', () => {
    const studio = source('CreativeStudioV3.tsx')
    const home = source('StudioV3Home.tsx')
    const projects = source('StudioV3CapabilityDesk.tsx')

    expect(home).toContain("title: 'Long-form'")
    expect(home).toContain('project.id === initialProjectId')
    expect(home).toContain('!project.readonly')
    expect(home).toContain('onOpenComposition(initialProject)')
    expect(projects).toContain('onOpenComposition(selectedProject)')
    expect(projects).toContain('Legacy project · Editor unavailable')
    expect(studio).toContain('resolveStudioProjectComposition')
    expect(studio).toContain("id: 'editor'")
    expect(studio).toContain("returnTo: 'home' | 'projects'")
    expect(studio).toContain("desk: 'projects'")
    expect(studio).toContain('projectId: editorView.projectId')
  })

  it('carries server-derived actor identity, exact access role, and exact scope', () => {
    const studio = source('CreativeStudioV3.tsx')
    const journey = source('StudioV3EditorJourney.tsx')

    expect(routeSource).toContain('actorUserId: actor.userId')
    expect(routeSource).toContain('studioRole: decision.brand.role')
    expect(routeSource).toContain('accessibleProjects')
    expect(routeSource).toContain('getCreativeStudioV3FoundationFlags')
    expect(studio).toContain('accessRole: resolved.composition.accessRole')
    expect(journey).toContain('userId: actorUserId')
    expect(journey).toContain('role: accessRole')
    expect(journey).toContain('brandProfileId: scope.brandProfileId')
    expect(journey).toContain('projectId: scope.projectId')
    expect(journey).toContain('scope.compositionId')
    expect(journey).toContain('scope={scope}')
  })

  it('creates one stable Foundation command port per mounted scope with authoritative enrichment', () => {
    const journey = source('StudioV3EditorJourney.tsx')
    const context = source('editor-context.ts')

    expect(journey).toContain('const commandPort = useMemo(')
    expect(journey).toContain('createFoundationCompositionCommandPort')
    expect(journey).toContain('loadSnapshotContext')
    expect(journey).toContain('loadCreativeStudioV3EditorSnapshotContext')
    expect(context).toContain('fetchProjectAssets(view.projectId)')
    expect(context).toContain('fetchStudioReview')
    expect(context).toContain('view.history.activity')
    expect(context).toContain("history: 'hydrated'")
    expect(context).toContain('referenceContract')
    expect(context).toContain('lineage:')
    expect(context).not.toMatch(/localStorage|sessionStorage/)
  })

  it('uses access-scoped project discovery with the route snapshot as truthful recovery', () => {
    const home = source('StudioV3Home.tsx')
    const desks = source('StudioV3CapabilityDesk.tsx')
    const studio = source('CreativeStudioV3.tsx')

    expect(home).toContain('port.loadHome(activeBrand.brandProfileId')
    expect(home).toContain('unscoped legacy records are excluded')
    expect(desks).toContain('port.listProjects(activeBrand.brandProfileId)')
    expect(desks).toContain('using the authenticated route snapshot')
    expect(studio).toContain('initialContext.accessibleProjects.find')
    expect(home).not.toContain('fetchStudioProjects')
    expect(desks).not.toContain('fetchStudioProjects')
  })

  it('treats localStorage as a remembered accessible ID, never project or role authority', () => {
    const studio = source('CreativeStudioV3.tsx')

    expect(studio).toContain('selectAccessibleStudioBrand(')
    expect(studio).toContain('rows,')
    expect(studio).toContain('window.localStorage.getItem(ACTIVE_BRAND_KEY)')
    expect(studio).not.toMatch(/localStorage\.(getItem|setItem).*project/i)
    expect(studio).not.toMatch(/localStorage\.(getItem|setItem).*role/i)
    expect(studio).toContain('router.replace')
    expect(studio).toContain("query.delete('project')")
  })

  it('presents reviewer and rollout preview as read-only while keeping server rejection authoritative', () => {
    const journey = source('StudioV3EditorJourney.tsx')

    expect(journey).toContain("accessRole === 'reviewer'")
    expect(journey).toContain('!foundationWritesEnabled')
    expect(journey).toContain('readOnly={readOnly}')
    expect(editorSource).toContain('presentationReadOnly')
    expect(editorSource).toContain('commandPort.applyLocal')
    expect(editorSource).toContain('commandPort.undo')
    expect(editorSource).toContain('disabled={presentationReadOnly')
    expect(workbenchSource).toContain('disabled={readOnly}')
    expect(workbenchSource).toContain('Preview only')
  })

  it('ships no fabricated Editor success state or paid/external execution method', () => {
    const client = source('composition-client.ts')

    expect(stageSource).toContain('Preview not hydrated')
    expect(stageSource).toContain('activeAsset?.previewUrl')
    expect(stageSource).not.toContain('Quiet confidence')
    expect(stageSource).not.toContain('EID / 2026')
    expect(workbenchSource).not.toContain('Bring the first caption forward')
    expect(client).toContain('listCompositions')
    expect(client).toContain('createComposition')
    expect(client).toContain('getComposition')
    expect(client).not.toMatch(/\b(queue|publish|render|voice|providerCall)\s*\(/)
    expect(source('StudioV3EditorJourney.tsx')).toContain('generationProvider={null}')
    expect(source('StudioV3EditorJourney.tsx')).toContain('voice={null}')
  })

  it('keeps keyboard, focus, embedded responsive layout, and reduced motion', () => {
    const v3Styles = source('creative-studio-v3.module.css')

    expect(editorSource).toContain("window.addEventListener('keydown', handleKeyDown)")
    expect(editorSource).toContain("window.removeEventListener('keydown', handleKeyDown)")
    expect(editorSource).toContain('presentationReadOnly')
    expect(editorStyles).toContain('[data-embedded="true"]')
    expect(editorStyles).toContain('@media (max-width: 767px)')
    expect(editorStyles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(v3Styles).toContain('.shellBodyImmersive')
    expect(v3Styles).toContain('.editorHost')
  })

  it('keeps Editor enrichment read-only and hands Lifecycle authority to the Review desk', () => {
    expect(workbenchSource).toContain('Use the Studio Review desk')
    expect(workbenchSource).toContain('exact composition-pinned approval')
    expect(workbenchSource).not.toContain('transitionStudioReview')
    expect(workbenchSource).not.toContain('approveStudio')
  })
})
