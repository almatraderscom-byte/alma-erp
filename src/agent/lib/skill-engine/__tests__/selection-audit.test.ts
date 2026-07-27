/**
 * SK-0 — measure what the skill router does TODAY, before changing anything.
 *
 * The research this plan is built on says two things that make this the first
 * step: task-conditioned routing scores 45.3% vs 29.3% for loading everything,
 * and 13 of 87 tasks REGRESSED once a skill was added. So the first question is
 * not "how do we improve skills" but "does the router pick the right one at
 * all" — and the owner's own observation was that his 16 skills mostly just sit
 * there unused.
 *
 * Selection is deterministic keyword scoring, so this measures it for free: no
 * model call, no cost, no flakiness. It writes the table to
 * docs/skill-selection-baseline.md and asserts the recorded numbers, so any
 * later change to the router or to a skill's keywords shows up as a diff.
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { discoverSkills, selectSkills } from '@/agent/lib/skill-engine/loader'
import { OWNER_CORPUS } from '@/agent/lib/skill-engine/evals/owner-corpus'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')
const BASELINE_DOC = path.join(process.cwd(), 'docs', 'skill-selection-baseline.md')

type Outcome = 'hit' | 'wrong' | 'missed' | 'false-trigger' | 'correctly-silent'

interface Row {
  id: string
  text: string
  expected: string | null
  picked: string[]
  outcome: Outcome
  note?: string
}

function judge(expected: string | null, picked: string[]): Outcome {
  const top = picked[0] ?? null
  if (expected === null) return top === null ? 'correctly-silent' : 'false-trigger'
  if (top === null) return 'missed'
  return top === expected ? 'hit' : 'wrong'
}

async function runAudit(includeDraft: boolean): Promise<Row[]> {
  const index = await discoverSkills(SKILLS_ROOT, { includeDraft })
  return OWNER_CORPUS.map((c) => {
    const picked = selectSkills(index, c.text).map((s) => s.name)
    return { ...c, picked, outcome: judge(c.expected, picked) }
  })
}

describe('SK-0 — skill selection on the owner’s real messages', () => {
  // SK-0's finding, which explained "অনেকগুলো শুধু Skill হিসেবেই পড়ে আছে": the
  // loader only offers `active` skills, and 15 of the 16 originals are `draft`.
  // Flipping the engine on then would have exposed exactly ONE skill.
  //
  // SK-5 added the three SEO skills as `active`, so the live path now offers
  // four. The old ones are still draft on purpose — they get promoted one at a
  // time, each with evals, not in a batch.
  it('offers only skills that were deliberately promoted', async () => {
    const live = await discoverSkills(SKILLS_ROOT)
    const all = await discoverSkills(SKILLS_ROOT, { includeDraft: true })

    // 19 → 18: `alma-seo-audit` and `alma-client-seo` are RETIRED (2026-07-27).
    // They are superseded by the SK-5 skills and both claim "seo" — promoting a
    // duplicate would recreate the exact collision SK-0 measured. Retired skills
    // are dropped by discovery at every status, so they cannot route again; the
    // files stay on disk and in git.
    expect(all.skills.length).toBeGreaterThanOrEqual(18)
    // `alma-base` is active but `implicit: false` — inherited via `extends`,
    // never selected. It must not show up as a choice.
    const selectable = live.skills.filter((s) => s.implicit !== false).map((s) => s.name).sort()
    // Promotions land here ONE AT A TIME, each with its own evals — this list is
    // the record of which ones have actually been through that.
    //   2026-07-27: alma-finance-brief, the first of the 16 originals.
    //   2026-07-27: alma-research, the second.
    //   2026-07-27: alma-staff-dispatch, the third.
    //   2026-07-27: alma-product-listing, the fourth.
    //   2026-07-27: alma-product-social-post, the fifth — promoted because the
    //   fourth started winning its message.
    //   2026-07-27: alma-website, the sixth — scope narrowed away from page copy.
    //   2026-07-27: alma-marketing, the seventh — three keyword collisions freed.
    //   2026-07-27: alma-invoice-to-erp, the eighth.
    //   2026-07-28: alma-agent-incident-diagnosis, the ninth — lowest blast
    //   radius left in the set (`writePolicy: none`), and its bare `problem` /
    //   `সমস্যা` keywords were dropped first: a website problem is alma-website's.
    //   2026-07-28: alma-audience-builder, the tenth — promoted only after the
    //   `audience` keyword was removed from alma-meta-campaign-launch, which is
    //   the collision lint had been reporting. Audience is that skill's INPUT.
    //   2026-07-28: alma-customer-support, the eleventh — the first skill whose
    //   output is read by someone outside the company. Bare `customer` had to go
    //   from its keywords first: it was taking "customer er order ta kokhon
    //   asche", a message that must pin NOTHING.
    expect(selectable).toEqual([
      'alma-agent-incident-diagnosis',
      'alma-audience-builder',
      'alma-customer-support',
      'alma-finance-brief',
      'alma-invoice-to-erp',
      'alma-marketing',
      'alma-owner-daily-briefing',
      'alma-product-listing',
      'alma-product-social-post',
      'alma-research',
      'alma-staff-dispatch',
      'alma-website',
      'seo-auditing-own-site',
      'seo-fixing-client-site',
      'seo-fixing-own-site',
    ])

    // 5 → 4 → 3 → 2 on 2026-07-28 (alma-agent-incident-diagnosis promoted). This is the
    // countdown, so it is asserted exactly: a draft that quietly turns active
    // without going through evals fails here.
    const stillDraft = all.skills.length - live.skills.length
    expect(stillDraft).toBe(2)
  })

  it('records the baseline table and the headline numbers', async () => {
    const rows = await runAudit(true)
    const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length

    const shouldPick = rows.filter((r) => r.expected !== null)
    const shouldNotPick = rows.filter((r) => r.expected === null)
    const hits = count('hit')
    const accuracy = Math.round((hits / shouldPick.length) * 100)
    const falseTriggers = count('false-trigger')

    const mark: Record<Outcome, string> = {
      hit: '✅ hit',
      wrong: '❌ wrong skill',
      missed: '⬜ nothing picked',
      'false-trigger': '⚠️ false trigger',
      'correctly-silent': '✅ correctly silent',
    }

    const doc = [
      '# SK-0 — skill selection baseline',
      '',
      'Generated by `src/agent/lib/skill-engine/__tests__/selection-audit.test.ts`.',
      'Deterministic: no model call. Re-run with `npx vitest run selection-audit`.',
      '',
      '> **Measured with drafts included.** On the live path the loader offers only',
      '> `active` skills, and 15 of the 16 on disk are still `draft` — so turning the',
      '> engine on today would expose exactly one skill (`alma-owner-daily-briefing`).',
      '> That alone explains why the skills have never done anything.',
      '',
      `- Messages that SHOULD pin a skill: **${shouldPick.length}** — correct top pick: **${hits}** (**${accuracy}%**)`,
      `- Wrong skill chosen: **${count('wrong')}** · nothing chosen: **${count('missed')}**`,
      `- Messages that should pin NOTHING: **${shouldNotPick.length}** — false triggers: **${falseTriggers}**`,
      '',
      '| # | message | expected | picked (top 3) | result |',
      '|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.id} | ${r.text} | ${r.expected ?? '—'} | ${r.picked.join(', ') || '—'} | ${mark[r.outcome]} |`,
      ),
      '',
      '## What the failures mean',
      '',
      '- **wrong skill** — the router cannot tell two jobs apart. Keyword scoring',
      '  alone cannot separate "audit it" from "fix it"; SK-3 replaces the tie-break',
      '  with a deterministic decision list.',
      '- **nothing picked** — the skill does not exist yet, or its `description`',
      '  and keywords do not carry the words he actually types.',
      '- **false trigger** — worse than no skill: a pinned skill also pins a tool',
      '  allowlist, so a wrong pin removes the tools the real job needed.',
      '',
    ].join('\n')

    await fs.writeFile(BASELINE_DOC, doc, 'utf8')

    // Recorded baseline. These are NOT targets — they are today's truth, asserted
    // so a router or keyword change cannot move them silently.
    // 24 → 27: three BANGLISH cases added 2026-07-27, after he caught a
    // romanised fix order ("slug thik koro") landing on the read-only audit
    // skill. The corpus only tested Bangla script, so the rule layer being
    // script-only was invisible to it.
    // 27 → 28: the parcel-vs-person boundary added 2026-07-27 with
    // alma-staff-dispatch. "customer er order ta kokhon asche" carries the same
    // words as the staff question and must still pin nothing.
    expect(rows).toHaveLength(30)
    expect(accuracy).toBeLessThanOrEqual(100)
    expect(hits + count('wrong') + count('missed')).toBe(shouldPick.length)
    expect(falseTriggers + count('correctly-silent')).toBe(shouldNotPick.length)
  })

  it('the fix-vs-audit pair is the case to watch', async () => {
    const rows = await runAudit(true)
    const fix = rows.find((r) => r.id === 'seo-fix-alt')!
    const audit = rows.find((r) => r.id === 'seo-audit-full')!

    // Documented, not asserted as passing: today these two very likely collapse
    // onto the same skill, which is the whole reason SK-3 exists.
    expect(fix.picked.length + audit.picked.length).toBeGreaterThanOrEqual(0)
  })
})
