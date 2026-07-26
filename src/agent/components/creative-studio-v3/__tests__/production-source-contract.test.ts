import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src/agent/components/creative-studio-v3')
const source = (name: string) => readFileSync(join(sourceRoot, name), 'utf8')
const routeSource = readFileSync(
  join(process.cwd(), 'src/app/agent/creative-studio/page.tsx'),
  'utf8',
)

describe('Creative Studio V3 production source contract', () => {
  it('keeps the route default-off with an explicit legacy fallback', () => {
    const policy = source('rollout-policy.ts')

    expect(routeSource).toContain('listAccessibleStudioBrands')
    expect(routeSource).toContain('resolveCreativeStudioV3RouteDecision')
    expect(routeSource).toContain("first(searchParams?.studio) === 'legacy'")
    expect(routeSource).toContain('return <CreativeStudio />')
    expect(policy).toContain("CREATIVE_STUDIO_V3_UI_ENABLED !== '1'")
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
      expect(content).not.toMatch(/queue(?:Advanced|Auto|Owned)/)
    }
    const finishing = source('StudioV3Finishing.tsx')
    expect(finishing).toContain("activeBrand?.role === 'owner'")
    expect(finishing).toContain('ownerScopedActionAvailable')
    expect(finishing).toContain('projectAssetId')
    expect(source('types.ts')).toContain('CreativeStudioV3ReviewQueuePort')
  })

  it('wires Lifecycle through a zero-cost typed port with no paid or external command', () => {
    const client = source('lifecycle-client.ts')
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
