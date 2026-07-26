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

  it('keeps collaborator calls off owner-only production routes', () => {
    for (const file of ['StudioV3ImageLab.tsx', 'StudioV3VideoLab.tsx', 'StudioV3Finishing.tsx']) {
      const content = source(file)
      expect(content).toContain("activeBrand?.role === 'owner'")
      expect(content).toContain('ownerActionAvailable')
    }
    expect(source('types.ts')).toContain('CreativeStudioV3ReviewQueuePort')
  })
})
