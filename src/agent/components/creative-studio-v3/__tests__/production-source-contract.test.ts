import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src/agent/components/creative-studio-v3')
const source = (name: string) => readFileSync(join(sourceRoot, name), 'utf8')
const routeSource = readFileSync(
  join(process.cwd(), 'src/app/agent/creative-studio/page.tsx'),
  'utf8',
)
const legacyShellSource = readFileSync(
  join(process.cwd(), 'src/agent/components/creative-studio/CreativeStudioShell.tsx'),
  'utf8',
)
const versionSwitcherSource = readFileSync(
  join(process.cwd(), 'src/agent/components/creative-studio/StudioVersionSwitcher.tsx'),
  'utf8',
)

describe('Creative Studio V3 production source contract', () => {
  it('keeps the route default-off with an explicit legacy fallback', () => {
    const policy = source('rollout-policy.ts')

    expect(routeSource).toContain('listAccessibleStudioBrands')
    expect(routeSource).toContain('resolveCreativeStudioV3RouteDecision')
    expect(routeSource).toContain("const forceLegacy = requestedStudio === 'legacy'")
    expect(routeSource).toContain("explicitStudio === 'v4'")
    expect(routeSource).toContain("process.env.VERCEL_ENV === 'preview'")
    expect(routeSource).toContain('getCreativeStudioV4PreviewFoundationFlags')
    expect(routeSource).toContain('requestedStudio: explicitStudio')
    expect(routeSource).toContain('return <CreativeStudio v4Targets={v4Targets} />')
    expect(routeSource).toContain('STUDIO_WEB_VERSION_COOKIE')
    expect(routeSource).toContain('actorIsSystemOwner')
    expect(routeSource).toContain('? cookieStore.get(STUDIO_WEB_VERSION_COOKIE)?.value')
    expect(policy).toContain("CREATIVE_STUDIO_V3_UI_ENABLED !== '1'")
  })

  it('persists only explicit web choices and carries only same-brand project context', () => {
    expect(versionSwitcherSource).toContain('persistVersion(version)')
    expect(versionSwitcherSource).not.toContain('useEffect')
    expect(legacyShellSource).toContain('canSwitchToStudioV4')
    expect(legacyShellSource).toContain(
      'activeProject?.brandProfileId === activeBrandProfileId',
    )
  })

  it('ships no demo/fixture imports, fake success state, or hard-coded initials', () => {
    const files = readdirSync(sourceRoot)
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
      .filter((file) => !file.endsWith('.test.ts'))
    const combined = files.map((file) => source(file)).join('\n')

    expect(combined).not.toMatch(/creative-studio-demo|studio-demo|\/demo\b/i)
    expect(combined).not.toMatch(/\bfixture(s)?\b/i)
    expect(combined).not.toMatch(/\bfake success\b/i)
    expect(source('StudioV3Shell.tsx')).not.toContain('>MB<')
    expect(routeSource).not.toContain("platformRoleLabel: 'System administrator'")
    expect(existsSync(join(
      process.cwd(),
      'src/app/agent/creative-studio/visual-check',
    ))).toBe(false)
    expect(existsSync(join(
      process.cwd(),
      'src/app/agent/creative-studio/editor-visual-check',
    ))).toBe(false)
  })

  it('gates the real Foundation editor attachment points with server flags', () => {
    const home = source('StudioV3Home.tsx')
    const desks = source('StudioV3CapabilityDesk.tsx')
    const video = source('StudioV3VideoLab.tsx')

    expect(home).toContain("'Foundation off'")
    expect(home).toContain('onOpenComposition(initialProject)')
    expect(desks).toContain("'Open composition'")
    expect(desks).toContain('foundationReadEnabled')
    expect(video).toContain('Foundation adapter required')
  })

  it('uses signed scoped run contracts for creators and keeps reviewers read-only', () => {
    for (const file of ['StudioV3ImageLab.tsx', 'StudioV3VideoLab.tsx']) {
      const content = source(file)
      expect(content).toContain("activeBrand.role !== 'reviewer'")
      expect(content).toContain('estimateRun')
      expect(content).toContain('confirmRun')
    }
    expect(source('StudioV3ImageLab.tsx')).not.toMatch(/queue(?:Advanced|Auto)/)
    expect(source('StudioV3VideoLab.tsx')).toContain('port.runVideoRecipe')
    expect(source('StudioV3VideoLab.tsx')).toContain('brandProfileId: activeBrand.brandProfileId')
    expect(source('StudioV3VideoLab.tsx')).toContain('projectId: activeProject.id')
    const finishing = source('StudioV3Finishing.tsx')
    expect(finishing).toContain("activeBrand?.role === 'owner'")
    expect(finishing).toContain('ownerScopedActionAvailable')
    expect(finishing).toContain('projectAssetId')
    expect(source('types.ts')).toContain('CreativeStudioV3ReviewQueuePort')
  })

  it('keeps the owner-approved V4 workflow on production adapters, not demo state', () => {
    const home = source('StudioV3Home.tsx')
    const image = source('StudioV3ImageLab.tsx')
    const video = source('StudioV3VideoLab.tsx')
    const shell = source('StudioV3Shell.tsx')
    const studio = source('CreativeStudioV3.tsx')
    const adapter = source('production-adapter.ts')
    const ownedVideoRoute = readFileSync(
      join(process.cwd(), 'src/app/api/assistant/creative-studio/video/run/route.ts'),
      'utf8',
    )
    const ownedVideoUploadUrlRoute = readFileSync(
      join(process.cwd(), 'src/app/api/assistant/creative-studio/video/upload-url/route.ts'),
      'utf8',
    )
    const ownedVideoRegistryRoute = readFileSync(
      join(process.cwd(), 'src/app/api/assistant/creative-studio/video/route.ts'),
      'utf8',
    )
    const referenceUploadRoute = readFileSync(
      join(process.cwd(), 'src/app/api/assistant/creative-studio/reference-upload/route.ts'),
      'utf8',
    )
    const runScope = readFileSync(
      join(process.cwd(), 'src/agent/lib/creative-studio/studio-run-scope.ts'),
      'utf8',
    )
    const executionGate = readFileSync(
      join(process.cwd(), 'src/lib/creative-studio/studio-run-execution-gate.ts'),
      'utf8',
    )

    expect(home).toContain('Create & open project')
    expect(home).toContain('PROJECT OPEN · CANVAS SETUP')
    expect(home).toContain('Use dimensions from scoped current media')
    expect(home).toContain('accept="image/*,video/*"')
    expect(home).toContain("title: 'Avatar'")
    expect(home).toContain('onCreateProject')
    expect(image).toContain('Expand image workspace')
    expect(image).toContain('Always visible inside the composer')
    expect(image).toContain('port.uploadReference')
    expect(image).toContain('productReferenceId')
    expect(image).toContain('modelReferenceId')
    expect(image).toContain('pasteProductReference')
    expect(image.slice(
      image.indexOf('const uploadReference'),
      image.indexOf('const pasteProductReference'),
    )).not.toContain("setArchitecture('advanced')")
    expect(video).toContain('Expand video workspace')
    expect(video).toContain('v6VideoStage')
    expect(video).toContain('uploadOwnedFootage')
    expect(video).toContain('projectId: activeProject.id')
    expect(video).toContain('queueOwnedEdit')
    expect(shell).toContain('Ask Creative Agent')
    expect(studio).toContain("openComposition(activeProject, 'home', true)")
    expect(studio).toContain("openComposition(project, 'home', false, canvas)")
    expect(adapter).toContain('createProject: createStudioProject')
    expect(adapter).toContain('uploadReference: uploadStudioReference')
    expect(adapter).toContain('runVideoRecipe')
    expect(ownedVideoRoute).toContain("assertStudioResourceScope('video', uploadId")
    expect(ownedVideoRoute).toContain('registeredPath !== videoPath')
    expect(ownedVideoUploadUrlRoute).toContain("assertStudioCapability(context.access.role, 'draft')")
    expect(ownedVideoRegistryRoute).toContain("assertStudioCapability(resourceContext.access.role, 'draft')")
    expect(referenceUploadRoute).toContain("writeStudioResourceScope('reference'")
    expect(referenceUploadRoute).toContain("assertStudioCapability(context.access.role, 'draft')")
    expect(runScope).toContain("assertStudioResourceScope('reference', productReferenceId")
    expect(runScope).toContain("assertStudioResourceScope('reference', modelReferenceId")
    expect(executionGate).toContain('claims.scope.referencePins')
  })

  it('wires Lifecycle through a zero-cost typed port with no paid or external command', () => {
    const client = source('lifecycle-client.ts')
    const adapter = source('production-adapter.ts')
    const review = source('StudioV3LifecycleReview.tsx')
    const operations = source('StudioV3LifecycleOperations.tsx')
    const route = readFileSync(
      join(
        process.cwd(),
        'src/app/api/assistant/creative-studio/lifecycle/route.ts',
      ),
      'utf8',
    )

    expect(client).toContain("effectClass: 'zero_cost_local'")
    expect(client).toContain('estimatedCostBdt: 0')
    expect(client).toContain("capability === 'live_publish' && input.enabled")
    expect(client).not.toMatch(/\b(?:publish|schedule|voice|paidRender)\s*\(/)
    expect(client).toContain('/review/${encodeURIComponent(input.assetId)}')
    expect(adapter).toContain(
      'transitionReview: studioV3LifecycleClient.transitionReview',
    )
    expect(adapter).not.toContain('transitionStudioReview')
    expect(review).toContain('Approve exact pin')
    expect(review).toContain('V3 does not expose review, queue, control or flag mutations to collaborators.')
    expect(operations).toContain('This does not prove a VPS loop is running.')
    for (const capability of [
      'preview',
      'render',
      'export',
      'dry_run',
      'schedule',
      'live_publish',
    ]) {
      expect(route).toContain(`'${capability}'`)
    }
  })
})
