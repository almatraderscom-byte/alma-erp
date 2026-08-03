/**
 * Tier-1 Mac skills — the ACTIVATION half.
 *
 * Routing proves the right skill is chosen. This proves the chosen skill
 * actually arrives intact at the model, which is a different failure:
 *
 *  • `SYSTEM.md` sat on disk for a whole phase with nothing reading it (SK-7).
 *    A file nobody opens is indistinguishable from a file nobody wrote.
 *  • `runtime.ts` truncates the body at `MAX_SKILL_BODY_CHARS` (6,000). Every
 *    one of these skills keeps its refusal list at the BOTTOM — "no `rm`",
 *    "no pipeline without his yes" — so a body that grows past the cap loses
 *    its guards silently while still looking like a loaded skill.
 *  • `alma-base` is inherited, never selected, and an isolated turn drops the
 *    general prompt — so if the base does not ride along, the ALMA invariants
 *    leave with it.
 */
import { describe, expect, it } from 'vitest'
import path from 'path'
import { discoverSkills, activateSkill } from '@/agent/lib/skill-engine/loader'
import { buildIsolatedSystemPrompt, isIsolatedSkill } from '@/agent/lib/skill-engine/isolation'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')
/** Must stay in step with `MAX_SKILL_BODY_CHARS` in runtime.ts. */
const BODY_CAP = 6000

const MAC_SKILLS = [
  'mac-ai-app-operator',
  'xcode-testflight-shipper',
  'git-pr-workflow',
  'mac-file-organizer',
  'screenshot-annotate-share',
] as const

/** The last line of defence in each skill — the text that must survive. */
const GUARD_PHRASE: Record<string, string> = {
  'mac-ai-app-operator': 'পাসওয়ার্ড, API key, OTP',
  'xcode-testflight-shipper': 'স্পষ্ট অনুমতি ছাড়া pipeline চালু নয়',
  'git-pr-workflow': 'force push নয়',
  'mac-file-organizer': '`rm` নয়',
  'screenshot-annotate-share': 'পড়ে শোনাবে না',
}

describe('every Tier-1 Mac skill activates whole', () => {
  for (const name of MAC_SKILLS) {
    it(`${name}: body, guards and base all arrive`, async () => {
      const index = await discoverSkills(SKILLS_ROOT)
      const meta = index.skills.find((s) => s.name === name)
      expect(meta, `${name} must be discoverable`).toBeTruthy()

      const activated = await activateSkill(meta!)
      expect(activated, `${name} must activate`).toBeTruthy()

      // The procedure survives the runtime's truncation, guards included.
      expect(activated!.instructions.length).toBeLessThan(BODY_CAP)
      expect(activated!.instructions).toContain(GUARD_PHRASE[name])

      // The ALMA invariants ride along via `extends`, or an isolated turn
      // would run without them.
      expect(activated!.manifest.extends).toBe('alma-base')
      expect(activated!.baseInstructions).toContain('Boss')
    })
  }

  it('the four acting skills isolate, and carry their own SYSTEM.md', async () => {
    const index = await discoverSkills(SKILLS_ROOT)
    for (const name of MAC_SKILLS) {
      const activated = await activateSkill(index.skills.find((s) => s.name === name)!)
      const isolated = isIsolatedSkill(activated!.manifest)
      // The read-only screen skill stays inline on purpose — nothing to isolate.
      expect(isolated, name).toBe(name !== 'screenshot-annotate-share')
      if (isolated) {
        expect(activated!.systemPrompt, `${name} SYSTEM.md`).not.toBe('')
      }
    }
  })

  it('an isolated prompt is assembled in the documented order', async () => {
    const index = await discoverSkills(SKILLS_ROOT)
    const activated = await activateSkill(
      index.skills.find((s) => s.name === 'mac-file-organizer')!,
    )
    const prompt = buildIsolatedSystemPrompt('KERNEL-TEXT', {
      skillName: activated!.manifest.name,
      baseInstructions: activated!.baseInstructions,
      systemPrompt: activated!.systemPrompt,
      instructions: activated!.instructions,
    })
    const order = ['KERNEL-TEXT', 'alma-base', 'তোমার ভূমিকা ও সীমা', 'কাজের ধাপ (procedure)']
    let cursor = -1
    for (const marker of order) {
      const at = prompt.indexOf(marker)
      expect(at, marker).toBeGreaterThan(cursor)
      cursor = at
    }
    // The one that matters most: the Trash-only rule is in the assembled text.
    expect(prompt).toContain('Trash')
  })
})
