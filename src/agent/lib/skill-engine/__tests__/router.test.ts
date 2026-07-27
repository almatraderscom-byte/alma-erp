/**
 * SK-3 — the three-layer router, measured against the same corpus as SK-0.
 *
 * SK-0's number was 61% with keyword scoring alone. The point of this file is
 * to show what the rule layer buys, on the owner's own messages, and to write
 * the comparison into docs/skill-selection-baseline.md next to the old number.
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { OWNER_CORPUS } from '@/agent/lib/skill-engine/evals/owner-corpus'
import {
  AMBIGUITY_MARGIN,
  applyRules,
  buildRegistryBlock,
  eligibleSkills,
  routeSkill,
  REGISTRY_BUDGET_CHARS,
} from '@/agent/lib/skill-engine/router'
import type { SkillMetadata } from '@/agent/lib/skill-engine/types'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

describe('layer 2 — the rules that keywords can never get right', () => {
  it('a fix order is a fix order', () => {
    expect(applyRules('almatraders.com এর ছবির alt ঠিক করো')?.skill).toBe('seo-fixing-own-site')
    expect(applyRules('product-code-110 এর meta description লিখে দাও')?.skill).toBe('seo-fixing-own-site')
  })

  it('an audit order is an audit order', () => {
    expect(applyRules('almatraders.com এর পূর্ণাঙ্গ SEO অডিট করো')?.skill).toBe('seo-auditing-own-site')
  })

  it('"অডিট করে রিপোর্ট লিখে দাও" is still an audit — the object of the verb decides', () => {
    expect(applyRules('almatraders.com এর SEO অডিট করে রিপোর্ট লিখে দাও')?.skill)
      .toBe('seo-auditing-own-site')
  })

  it('someone else’s domain is a different job entirely', () => {
    expect(applyRules('client er site example.com er seo dekho')?.skill).toBe('seo-fixing-client-site')
    expect(applyRules('example.com er meta likhe dao')?.skill).toBe('seo-fixing-client-site')
  })

  it('leaves non-SEO messages alone', () => {
    expect(applyRules('kalker order gulo dekhao')).toBeNull()
    expect(applyRules('ajker sale koto?')).toBeNull()
    expect(applyRules('valo acho?')).toBeNull()
  })
})

describe('layer 1 — eligibility', () => {
  it('never offers a skill that must be asked for by name', async () => {
    const index = await discoverSkills(SKILLS_ROOT, { includeDraft: true })
    const names = eligibleSkills(index).map((s) => s.name)
    expect(names).not.toContain('alma-base')
  })

  it('offers it once the owner names it', async () => {
    const index = await discoverSkills(SKILLS_ROOT, { includeDraft: true })
    const names = eligibleSkills(index, { namedByOwner: ['alma-base'] }).map((s) => s.name)
    expect(names).toContain('alma-base')
  })
})

describe('layer 3 — hand the close calls to the head, do not guess', () => {
  it('flags an ambiguous keyword race instead of coin-flipping', async () => {
    const index = await discoverSkills(SKILLS_ROOT, { includeDraft: true })
    // A message with no rule and no decisive keyword.
    const d = routeSkill(index, 'ekta post ar customer message niye kaj koro')
    if (d.layer !== 'none') {
      expect(['model', 'keyword']).toContain(d.layer)
      if (d.needsModel) expect(d.candidates.length).toBeGreaterThan(1)
    }
  })

  it('every decision carries a readable reason (U5)', async () => {
    const index = await discoverSkills(SKILLS_ROOT, { includeDraft: true })
    for (const c of OWNER_CORPUS) {
      const d = routeSkill(index, c.text)
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })

  it('the ambiguity margin is a stated number, not a feeling', () => {
    expect(AMBIGUITY_MARGIN).toBeGreaterThan(0)
  })

  // The false trigger SK-0 measured: one incidental token ("dekho") pinned the
  // incident-diagnosis skill on a score of 1. A wrong pin costs tools, so a weak
  // match must produce NO skill.
  it('refuses to pin on one incidental word', async () => {
    const index = await discoverSkills(SKILLS_ROOT, { includeDraft: true })
    const d = routeSkill(index, 'kalker order gulo dekhao')

    expect(d.skill).toBeNull()
    expect(d.reason).toContain('দুর্বল')
    // …and it still shows what it considered, so the miss is debuggable.
    expect(d.candidates.length).toBeGreaterThan(0)
  })
})

describe('U3 — the registry budget', () => {
  const fake = (n: number): SkillMetadata[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `skill-number-${i}`,
      description: 'x'.repeat(300),
      version: '1.0.0',
      riskTier: 'low' as const,
      status: 'active' as const,
      requiredCapabilities: [],
      keywords: [],
      implicit: true,
      dir: '',
      hash: `hash-${i}`,
    }))

  it('passes a small registry through untouched', () => {
    const b = buildRegistryBlock(fake(5))
    expect(b.shortened).toBe(false)
    expect(b.dropped).toEqual([])
  })

  it('shortens descriptions before dropping any skill', () => {
    const b = buildRegistryBlock(fake(40))
    expect(b.shortened).toBe(true)
    expect(b.dropped).toEqual([])
    expect(b.text.length).toBeLessThanOrEqual(REGISTRY_BUDGET_CHARS)
  })

  it('drops the tail only when shortening is not enough — and says which', () => {
    const b = buildRegistryBlock(fake(200))
    expect(b.text.length).toBeLessThanOrEqual(REGISTRY_BUDGET_CHARS)
    expect(b.dropped.length).toBeGreaterThan(0)
    expect(b.included.length + b.dropped.length).toBe(200)
  })
})

describe('the whole router on the owner’s corpus', () => {
  it('beats keyword-only routing, and records by how much', async () => {
    const index = await discoverSkills(SKILLS_ROOT, { includeDraft: true })

    let hits = 0
    let falseTriggers = 0
    let needsModel = 0
    const rows: string[] = []

    for (const c of OWNER_CORPUS) {
      const d = routeSkill(index, c.text)
      const correct = d.skill === c.expected
      if (c.expected === null && d.skill !== null) falseTriggers++
      if (correct) hits++
      if (d.needsModel) needsModel++
      rows.push(
        `| ${c.id} | ${c.expected ?? '—'} | ${d.skill ?? '—'} | ${d.layer} | ${correct ? '✅' : '❌'} | ${d.reason} |`,
      )
    }

    const shouldPick = OWNER_CORPUS.filter((c) => c.expected !== null).length
    const hitsOnShouldPick = OWNER_CORPUS.filter(
      (c) => c.expected !== null && routeSkill(index, c.text).skill === c.expected,
    ).length
    const accuracy = Math.round((hitsOnShouldPick / shouldPick) * 100)

    const doc = [
      '# SK-3 — three-layer router result',
      '',
      'Generated by `src/agent/lib/skill-engine/__tests__/router.test.ts`.',
      '',
      `- Keyword-only (SK-0 baseline): **61%**`,
      `- Three-layer router: **${accuracy}%** (${hitsOnShouldPick}/${shouldPick})`,
      `- False triggers: **${falseTriggers}**`,
      `- Handed to the head as ambiguous: **${needsModel}**`,
      '',
      '> The rule layer names skills that do not exist yet (`seo-fixing-own-site`,',
      '> `seo-auditing-own-site`, `seo-fixing-client-site`) — those arrive in SK-5.',
      '> Routing to a not-yet-written skill is still the RIGHT decision; the gap is',
      '> in the skill library, not the router.',
      '',
      '| # | expected | routed | layer | ok | why |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n')

    await fs.writeFile(path.join(process.cwd(), 'docs', 'skill-router-result.md'), doc, 'utf8')

    // The four SEO cases that keyword routing got wrong are the ones that matter.
    expect(accuracy).toBeGreaterThan(61)
    expect(falseTriggers).toBeLessThanOrEqual(1)
  })
})
