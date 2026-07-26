import { describe, it, expect } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import {
  buildOwnerRequirementNote,
  deriveOwnerTurnRequirements,
} from '@/agent/lib/owner-turn-requirements'
import { buildSystemPromptBlocks, PROMPT_MODULES } from '@/agent/lib/system-prompt'

/**
 * SK-6 — task knowledge belongs to the skill, not to global code.
 *
 * The owner's central complaint: *"evabe agent ke shikhate gele amr onno kono
 * feature er moddhe effect holew tmi sheta bujhbe na."* Teaching the agent one
 * job by editing a file every other job also reads is how a fix to the SEO
 * procedure silently changes a staff turn.
 *
 * The line is the one §6 of the plan draws: global code keeps what is true of
 * EVERY job; a skill keeps what is true of ONE job. These tests hold that line
 * from both sides — the SEO procedure is gone from the global note when a skill
 * is pinned, and it is genuinely present in the skill file (a move, not a
 * deletion).
 */
const SEO_PROCEDURE_LINES = [
  'Each target requires its own crawl',
  'A client-ready artifact is REQUIRED',
]

describe('SK-6 — the SEO procedure leaves the global requirement note', () => {
  const seoText = 'almatraders.com এর SEO অডিট করে দাও'

  it('with no skill pinned the old contract is unchanged (production path)', () => {
    const req = deriveOwnerTurnRequirements(seoText)
    const note = buildOwnerRequirementNote(req)
    for (const line of SEO_PROCEDURE_LINES) expect(note).toContain(line)
  })

  it('with a skill pinned the SEO procedure is NOT repeated globally', () => {
    const req = deriveOwnerTurnRequirements(seoText)
    const note = buildOwnerRequirementNote(req, { skillPinned: true })
    for (const line of SEO_PROCEDURE_LINES) expect(note).not.toContain(line)
  })

  it('…but the job-independent requirements still hold', () => {
    const req = deriveOwnerTurnRequirements(
      'আমার Chrome দিয়ে almatraders.com আর example.com এর SEO দেখো',
    )
    const note = buildOwnerRequirementNote(req, { skillPinned: true })
    expect(note).toContain('Ordered targets')
    expect(note).toContain('Live Chrome is REQUIRED')
  })

  it('a non-SEO turn is untouched by any of this', () => {
    const req = deriveOwnerTurnRequirements('এটা মনে রাখো: Eyafi কাল ছুটিতে')
    expect(buildOwnerRequirementNote(req, { skillPinned: true }))
      .toBe(buildOwnerRequirementNote(req))
  })
})

/**
 * SK-6 COMPLETE, 2026-07-27. The client-SEO procedure is no longer skipped when
 * a skill is pinned — it is GONE from global code. `seo-fixing-client-site` is
 * the only place that describes that job.
 *
 * Measured before deleting: ten client-SEO phrasings, ten pins — the "no skill
 * pinned but the job IS client-SEO" case the text existed to cover did not
 * occur. What did not go, deliberately, is the two one-line contract statements
 * in `buildOwnerRequirementNote`: they are the floor if the engine is ever
 * switched off (see the comment there).
 */
describe('SK-6 — the job procedure is gone from the global prompt', () => {
  const stableText = (skillPinned?: boolean) =>
    buildSystemPromptBlocks({ forceFullPrompt: true, skillPinned })
      .stable.map((b) => b.text).join('')

  // A distinctive sentence from the deleted procedure.
  const DELETED = 'যেকোনো ওয়েবসাইট SEO অডিট'

  it('the module no longer exists in the registry', () => {
    expect(PROMPT_MODULES.find((x) => x.id === 'client_seo_audit_procedure')).toBeUndefined()
  })

  it('the text is absent whether or not a skill is pinned', () => {
    expect(stableText()).not.toContain(DELETED)
    expect(stableText(true)).not.toContain(DELETED)
  })

  it('forceFullPrompt cannot resurrect it — there is nothing to ship', () => {
    // Both calls above already set forceFullPrompt; this states the consequence.
    expect(stableText()).toBe(stableText(true))
  })

  it('it left computer_capabilities too — this was a move, then a delete', () => {
    const cc = PROMPT_MODULES.find((x) => x.id === 'computer_capabilities')!
    expect(cc.text).not.toContain(DELETED)
  })
})

describe('SK-6 — the knowledge actually landed in the skill', () => {
  it('seo-fixing-client-site carries the per-target and delivery rules', async () => {
    const body = await fs.readFile(
      path.join(process.cwd(), 'src', 'agent', 'skills', 'seo-fixing-client-site', 'SKILL.md'),
      'utf8',
    )
    // per-target ordering, and "prose is not delivery"
    expect(body).toContain('একটা শেষ করে তবেই পরেরটা')
    expect(body).toContain('save_artifact')
    expect(body).toContain('ডেলিভারি **নয়**')
    // the live-Chrome depth rule, in the skill's own words
    expect(body).toContain('৫-৮টা পেজ')
  })

  /**
   * The big one: 6.2 KB of client-SEO procedure lived inside the
   * `computer_capabilities` prompt module and shipped on every turn carrying a
   * browser or workbench tool. It is now a module of its own that a pinned skill
   * displaces, and the knowledge is in the skill file.
   */
  it('carries the report/compare/storage rules that were in computer_capabilities', async () => {
    const body = await fs.readFile(
      path.join(process.cwd(), 'src', 'agent', 'skills', 'seo-fixing-client-site', 'SKILL.md'),
      'utf8',
    )
    expect(body).toContain('read: "report"')   // the report IS the file card
    expect(body).toContain('read: "compare"')  // before/after proof after a fix
    expect(body).toContain('private')          // storage paths, never via workbench
    expect(body).toContain('approved')         // still crawling ≠ executed
  })
})
