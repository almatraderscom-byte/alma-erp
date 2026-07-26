import { describe, it, expect } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import {
  buildOwnerRequirementNote,
  deriveOwnerTurnRequirements,
} from '@/agent/lib/owner-turn-requirements'

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
    expect(body).toContain('৫টা আলাদা')
  })
})
