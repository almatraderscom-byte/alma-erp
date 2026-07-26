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

describe('SK-6 — the job procedure leaves the global prompt', () => {
  const jobModule = () => {
    const m = PROMPT_MODULES.find((x) => x.id === 'client_seo_audit_procedure')
    expect(m, 'the extracted module must exist').toBeTruthy()
    return m!.text.trim().slice(0, 120)
  }
  const stableText = (skillPinned?: boolean) =>
    buildSystemPromptBlocks({ forceFullPrompt: true, skillPinned })
      .stable.map((b) => b.text).join('')

  it('no skill pinned → it still ships, exactly as before', () => {
    expect(stableText()).toContain(jobModule())
  })

  it('a skill pinned → global code stops narrating the job', () => {
    expect(stableText(true)).not.toContain(jobModule())
  })

  it('skipping beats forceFullPrompt — "ship everything" must not resurrect it', () => {
    // forceFullPrompt is on in BOTH cases above; that is the point of this test.
    expect(stableText(true).length).toBeLessThan(stableText().length)
  })

  it('it is a MOVE: computer_capabilities no longer carries the job', () => {
    const cc = PROMPT_MODULES.find((x) => x.id === 'computer_capabilities')!
    expect(cc.text).not.toContain('যেকোনো ওয়েবসাইট SEO অডিট')
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
