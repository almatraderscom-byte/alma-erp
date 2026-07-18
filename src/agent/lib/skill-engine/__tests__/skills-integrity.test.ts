import { describe, it, expect } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { parseFrontmatter } from '@/agent/lib/skill-engine/loader'
import type { SkillManifest } from '@/agent/lib/skill-engine/types'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

async function readSkillDirs(): Promise<string[]> {
  const entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

/**
 * Every SHIPPED skill package (draft or active) must be well-formed and reference only
 * REAL Alma tools — a tool rename breaks CI here instead of silently breaking a skill
 * once the engine is enabled. Mirrors src/agent/lib/skill-packs/__tests__/packs.test.ts.
 */
describe('shipped skill packages integrity', () => {
  it('every skill has a valid manifest + SKILL.md whose frontmatter name matches', async () => {
    const dirs = await readSkillDirs()
    expect(dirs.length).toBeGreaterThan(0)
    const seen = new Set<string>()
    for (const dir of dirs) {
      const full = path.join(SKILLS_ROOT, dir)
      const manifest = JSON.parse(await fs.readFile(path.join(full, 'manifest.json'), 'utf8')) as SkillManifest
      expect(manifest.name, `${dir}: name`).toBeTruthy()
      expect(manifest.version, `${dir}: version`).toBeTruthy()
      expect(manifest.description, `${dir}: description`).toBeTruthy()
      expect(Array.isArray(manifest.requiredCapabilities), `${dir}: requiredCapabilities`).toBe(true)
      expect(['draft', 'reviewed', 'canary', 'active', 'retired']).toContain(manifest.status)
      expect(seen.has(manifest.name), `${dir}: duplicate skill name ${manifest.name}`).toBe(false)
      seen.add(manifest.name)

      const { frontmatter } = parseFrontmatter(await fs.readFile(path.join(full, 'SKILL.md'), 'utf8'))
      expect(frontmatter.name, `${dir}: SKILL.md frontmatter name`).toBe(manifest.name)
    }
  })

  it('every requiredCapability is a real tool in the live registry', async () => {
    const { TOOLS } = await import('@/agent/tools/registry')
    const registered = new Set(TOOLS.map((t: { name: string }) => t.name))
    const dirs = await readSkillDirs()
    const missing: string[] = []
    for (const dir of dirs) {
      const manifest = JSON.parse(
        await fs.readFile(path.join(SKILLS_ROOT, dir, 'manifest.json'), 'utf8'),
      ) as SkillManifest
      for (const cap of manifest.requiredCapabilities) {
        if (!registered.has(cap)) missing.push(`${manifest.name}:${cap}`)
      }
    }
    expect(missing, `skills reference unregistered tools: ${missing.join(', ')}`).toEqual([])
  }, 30_000)
})
