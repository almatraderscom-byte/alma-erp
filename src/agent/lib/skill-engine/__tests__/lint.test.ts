/**
 * SK-2 — the linter, and its verdict on the 16 skills we actually have.
 *
 * The second half of this file is the useful half: it runs every real skill
 * through the rules and writes docs/skill-lint-report.md. That report is the
 * work list for SK-5.
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import {
  DESCRIPTION_OVERLAP_LIMIT,
  errorsOnly,
  lintSkills,
  purposesOf,
  type LintableSkill,
} from '@/agent/lib/skill-engine/lint'
import { parseFrontmatter } from '@/agent/lib/skill-engine/loader'

const base = (over: Partial<LintableSkill> = {}): LintableSkill => ({
  name: 'seo-fixing-own-site',
  description: 'Fixes on-page SEO copy on almatraders.com. Use when Boss asks to fix or write SEO content.',
  body: '# SEO fix\n\n1. Measure the product.\n2. Draft the copy.\n3. Stage an approval card.\n',
  status: 'active',
  writePolicy: 'owner_gated',
  whenNotToUse: 'For a fresh audit or report, use seo-auditing-own-site.',
  stopConditions: ['ব্যাচে ১০টার বেশি হলে'],
  done: [{ tool: 'draft_seo_fixes' }],
  outputContract: { kind: 'approval_card' },
  ...over,
})

describe('rules that map to a real production failure', () => {
  it('a clean v2 skill produces no errors', () => {
    expect(errorsOnly(lintSkills([base()]))).toEqual([])
  })

  it('catches a first-person description — it is injected into the system prompt', () => {
    const f = lintSkills([base({ description: 'I can help you fix SEO problems on the website.' })])
    expect(f.map((x) => x.rule)).toContain('description-person')
  })

  it('warns when a description says WHAT but never WHEN', () => {
    const f = lintSkills([base({ description: 'Fixes on-page SEO copy on almatraders.com.' })])
    expect(f.map((x) => x.rule)).toContain('description-when')
  })

  // The exact SK-0 failure: "meta description লিখে দাও" hit the Meta ADS skill.
  it('catches two descriptions that compete for the same messages', () => {
    const a = base({ name: 'seo-fixing-own-site' })
    const b = base({
      name: 'seo-fixing-client-site',
      description: 'Fixes on-page SEO copy on client sites. Use when Boss asks to fix or write SEO content.',
    })
    const f = lintSkills([a, b])

    const overlap = f.find((x) => x.rule === 'description-overlap')
    expect(overlap).toBeDefined()
    expect(overlap!.message).toContain('seo-fixing-client-site')
  })

  it('leaves genuinely different skills alone', () => {
    const a = base()
    const b = base({
      name: 'staff-dispatching',
      description: 'Decides staff assignment from attendance and location. Use when Boss asks who is where.',
    })
    expect(lintSkills([a, b]).filter((x) => x.rule === 'description-overlap')).toEqual([])
  })

  it('flags a skill that audits AND edits AND deploys', () => {
    const f = lintSkills([
      base({
        description: 'Audits the website, fixes the issues and publishes the result. Use when Boss asks.',
        body: '1. audit everything\n2. fix it\n3. publish live\n4. verify\n',
      }),
    ])
    expect(f.map((x) => x.rule)).toContain('multi-purpose')
  })

  it('requires a done gate on any skill that can write', () => {
    const f = errorsOnly(lintSkills([base({ done: undefined })]))
    expect(f.map((x) => x.rule)).toContain('missing-done')
  })

  it('does not demand a done gate from a read-only skill', () => {
    const f = errorsOnly(
      lintSkills([base({ writePolicy: 'none', done: undefined, stopConditions: undefined })]),
    )
    expect(f).toEqual([])
  })

  it('reads a skill’s purposes off its own words', () => {
    expect(purposesOf(base())).toContain('edit')
    expect(purposesOf(base({ description: 'Audits the site and reports findings. Use when asked.' })))
      .toContain('audit')
  })

  it('the overlap threshold is calibrated on our real skills, not guessed', () => {
    // Worst real pair is 40%; everything else ≤13%. A 0.5 limit fired on nothing.
    expect(DESCRIPTION_OVERLAP_LIMIT).toBeGreaterThan(0.13)
    expect(DESCRIPTION_OVERLAP_LIMIT).toBeLessThan(0.4)
  })

  // The failure SK-0 actually measured: "meta description লিখে দাও" → Meta ADS.
  it('catches one keyword claimed by two skills', () => {
    const f = lintSkills([
      base({ name: 'seo-fixing-own-site', keywords: ['seo', 'meta', 'alt'] }),
      base({
        name: 'meta-campaign-launching',
        description: 'Plans a Meta ads campaign. Use when Boss asks to launch ads.',
        keywords: ['ads', 'meta', 'campaign'],
        writePolicy: 'none',
        done: undefined,
        stopConditions: undefined,
      }),
    ])
    const hit = f.find((x) => x.rule === 'keyword-collision')
    expect(hit).toBeDefined()
    expect(hit!.message).toContain('"meta"')
  })

  it('does not flag a multi-word keyword phrase — those are specific enough', () => {
    const f = lintSkills([
      base({ name: 'a-skill', keywords: ['seo audit'] }),
      base({ name: 'b-skill', keywords: ['seo audit'], writePolicy: 'none', done: undefined, stopConditions: undefined }),
    ])
    expect(f.filter((x) => x.rule === 'keyword-collision')).toEqual([])
  })
})

describe('the verdict on our 16 real skills', () => {
  it('writes the work list for SK-5', async () => {
    const root = path.join(process.cwd(), 'src', 'agent', 'skills')
    const dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)

    const skills: LintableSkill[] = []
    for (const dir of dirs) {
      const manifest = JSON.parse(await fs.readFile(path.join(root, dir, 'manifest.json'), 'utf8'))
      const { body, frontmatter } = parseFrontmatter(
        await fs.readFile(path.join(root, dir, 'SKILL.md'), 'utf8'),
      )
      skills.push({
        name: manifest.name,
        description: manifest.description ?? '',
        body,
        status: manifest.status,
        writePolicy: manifest.writePolicy,
        whenNotToUse: manifest.whenNotToUse,
        stopConditions: manifest.stopConditions,
        done: manifest.done,
        outputContract: manifest.outputContract,
        dependencies: manifest.dependencies,
        requiredCapabilities: manifest.requiredCapabilities,
        keywords: (frontmatter.keywords ?? '').split(',').map((k) => k.trim()).filter(Boolean),
      })
    }

    const findings = lintSkills(skills)
    const byRule = new Map<string, number>()
    for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1)

    const doc = [
      '# SK-2 — skill lint report',
      '',
      'Generated by `src/agent/lib/skill-engine/__tests__/lint.test.ts`.',
      '',
      `**${skills.length} skills · ${findings.length} findings ` +
        `(${errorsOnly(findings).length} errors, ${findings.length - errorsOnly(findings).length} warnings)**`,
      '',
      '## By rule',
      '',
      '| rule | count |',
      '|---|---|',
      ...[...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `| ${r} | ${n} |`),
      '',
      '## By skill',
      '',
      '| skill | severity | rule | detail |',
      '|---|---|---|---|',
      ...findings.map((f) => `| ${f.skill} | ${f.severity} | ${f.rule} | ${f.message} |`),
      '',
      '> A 2026 review of 238 real-world skills found 99% carried at least one',
      '> flaw a routine review catches. This is ours.',
      '',
    ].join('\n')

    await fs.writeFile(path.join(process.cwd(), 'docs', 'skill-lint-report.md'), doc, 'utf8')

    expect(skills.length).toBeGreaterThanOrEqual(16)
    // No assertion on the count: today it is a work list, not a gate. SK-5
    // promotes it to a gate once the skills are rewritten.
    expect(findings.length).toBeGreaterThanOrEqual(0)
  })
})
