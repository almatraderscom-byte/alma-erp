import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { parseFrontmatter, discoverSkills, selectSkills, activateSkill } from '@/agent/lib/skill-engine/loader'

async function writeSkill(
  root: string,
  slug: string,
  manifest: Record<string, unknown>,
  frontmatterKeywords: string,
  body: string,
) {
  const dir = path.join(root, slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${manifest.name}\nkeywords: ${frontmatterKeywords}\n---\n${body}`,
  )
}

describe('skill-engine loader (B1 foundation)', () => {
  let root: string

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'alma-skills-'))
    await writeSkill(
      root,
      'daily-briefing',
      {
        name: 'alma-owner-daily-briefing',
        description: 'Boss daily brief: sales, approvals, dispatch',
        version: '0.1.0',
        publisher: 'alma-native',
        license: 'proprietary',
        businessScopes: ['ALMA_LIFESTYLE'],
        riskTier: 'low',
        requiredCapabilities: ['get_daily_digest', 'get_sales_summary'],
        status: 'active',
      },
      'briefing, daily brief, owner briefing',
      '# Briefing\nStep 1: get_daily_digest.',
    )
    // A draft skill must NOT be offered.
    await writeSkill(
      root,
      'wip',
      {
        name: 'alma-wip',
        description: 'unfinished',
        version: '0.0.1',
        publisher: 'alma-native',
        license: 'proprietary',
        businessScopes: [],
        riskTier: 'low',
        requiredCapabilities: ['made_up_tool'],
        status: 'draft',
      },
      'wip',
      'draft body',
    )
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('parseFrontmatter splits `---` frontmatter from the body', () => {
    const { frontmatter, body } = parseFrontmatter('---\nname: x\nkeywords: a, b\n---\nhello world')
    expect(frontmatter.name).toBe('x')
    expect(frontmatter.keywords).toBe('a, b')
    expect(body).toBe('hello world')
  })

  it('discovery offers only active skills and flags unknown capabilities', async () => {
    const index = await discoverSkills(root, {
      knownCapabilities: new Set(['get_daily_digest', 'get_sales_summary']),
    })
    expect(index.skills.map((s) => s.name)).toEqual(['alma-owner-daily-briefing'])
    // The draft is excluded entirely (not just warned).
    expect(index.skills.some((s) => s.name === 'alma-wip')).toBe(false)
  })

  it('discovery warns when an active skill references a non-existent capability', async () => {
    // Re-point the active skill at an unknown capability.
    await writeSkill(
      root,
      'daily-briefing',
      {
        name: 'alma-owner-daily-briefing',
        description: 'Boss daily brief',
        version: '0.1.0',
        publisher: 'alma-native',
        license: 'proprietary',
        businessScopes: ['ALMA_LIFESTYLE'],
        riskTier: 'low',
        requiredCapabilities: ['get_daily_digest', 'ghost_tool'],
        status: 'active',
      },
      'briefing',
      '# Briefing',
    )
    const index = await discoverSkills(root, { knownCapabilities: new Set(['get_daily_digest']) })
    expect(index.warnings.some((w) => w.includes('ghost_tool'))).toBe(true)
  })

  it('selection routes a matching query to the skill, ≤3, and ignores unrelated text', async () => {
    const index = await discoverSkills(root)
    const hit = selectSkills(index, 'Boss ajker daily brief ta dao')
    expect(hit.map((s) => s.name)).toContain('alma-owner-daily-briefing')
    expect(hit.length).toBeLessThanOrEqual(3)

    const miss = selectSkills(index, 'weather in Dhaka tomorrow')
    expect(miss).toHaveLength(0)
  })

  it('activation loads the SKILL.md body on demand', async () => {
    const index = await discoverSkills(root)
    const activated = await activateSkill(index.skills[0])
    expect(activated).not.toBeNull()
    expect(activated!.instructions).toContain('Briefing')
    expect(activated!.manifest.name).toBe('alma-owner-daily-briefing')
  })
})
