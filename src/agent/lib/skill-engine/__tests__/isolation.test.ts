import { describe, it, expect, afterEach } from 'vitest'
import path from 'path'
import { discoverSkills, activateSkill } from '@/agent/lib/skill-engine/loader'
import {
  buildIsolatedSystemPrompt,
  findPromptLeaks,
  isIsolatedSkill,
} from '@/agent/lib/skill-engine/isolation'
import { buildActiveSkills, __resetSkillIndexCache } from '@/agent/lib/skill-engine/runtime'
import { buildSystemPromptBlocks, PROMPT_MODULES, compileStableCore } from '@/agent/lib/system-prompt'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

async function activateByName(name: string) {
  const index = await discoverSkills(SKILLS_ROOT, { includeDraft: true })
  const meta = index.skills.find((s) => s.name === name)
  expect(meta, `${name} must exist on disk`).toBeTruthy()
  const activated = await activateSkill(meta!)
  expect(activated).toBeTruthy()
  return activated!
}

/**
 * SK-7. The owner asked for a skill that runs under its OWN system prompt with
 * no unrelated rules attached. Two things have to be true for that, and both are
 * checked here on the REAL files and the REAL prompt builder — not on fixtures,
 * because the failure this replaces was exactly a file that existed and was
 * never read.
 */
describe('SK-7 — the skill package actually carries its own prompt', () => {
  it('reads SYSTEM.md, which nothing in the codebase used to open', async () => {
    const skill = await activateByName('seo-fixing-own-site')
    expect(skill.systemPrompt.length).toBeGreaterThan(200)
    expect(skill.systemPrompt).toContain('তুমি এখন কে')
  })

  it('resolves `extends: alma-base` so the invariants travel with the skill', async () => {
    const skill = await activateByName('seo-fixing-own-site')
    expect(skill.manifest.extends).toBe('alma-base')
    expect(skill.baseInstructions.length).toBeGreaterThan(200)
  })

  it('a package with no SYSTEM.md still activates (every v1 skill)', async () => {
    const skill = await activateByName('alma-base')
    expect(skill.systemPrompt).toBe('')
    expect(skill.baseInstructions).toBe('') // no `extends` of its own
    expect(skill.instructions.length).toBeGreaterThan(0)
  })

  it('only a skill that declares it runs isolated', () => {
    expect(isIsolatedSkill({ isolation: 'subagent' })).toBe(true)
    expect(isIsolatedSkill({ isolation: 'inline' })).toBe(false)
    expect(isIsolatedSkill({})).toBe(false)
    expect(isIsolatedSkill(null)).toBe(false)
  })
})

describe('SK-7 — the isolated prompt is kernel + skill, in that order', () => {
  it('keeps the kernel, the base and both skill files', async () => {
    const skill = await activateByName('seo-fixing-own-site')
    const prompt = buildIsolatedSystemPrompt('KERNEL_TEXT', {
      skillName: skill.manifest.name,
      baseInstructions: skill.baseInstructions,
      systemPrompt: skill.systemPrompt,
      instructions: skill.instructions,
    })
    expect(prompt.indexOf('KERNEL_TEXT')).toBe(0)
    expect(prompt).toContain('alma-base')
    expect(prompt).toContain('তুমি এখন কে')
    expect(prompt.indexOf('তোমার ভূমিকা ও সীমা')).toBeLessThan(prompt.indexOf('কাজের ধাপ (procedure)'))
  })

  it('says plainly that the gates and the tool list, not the text, are the limit', async () => {
    const skill = await activateByName('seo-fixing-own-site')
    const prompt = buildIsolatedSystemPrompt(compileStableCore(), {
      skillName: skill.manifest.name,
      baseInstructions: skill.baseInstructions,
      systemPrompt: skill.systemPrompt,
      instructions: skill.instructions,
    })
    expect(prompt).toContain('অনুমোদন, টাকা আর publish-এর গেট কোডে বসানো')
  })
})

/**
 * The enforcement, not the wording. `findPromptLeaks` looks for the text of any
 * non-kernel prompt module inside the prompt that was actually built. If the
 * swap silently fails, this is what says so.
 */
describe('SK-7 — measured on the real system prompt', () => {
  const skillArg = {
    skillName: 'seo-fixing-own-site',
    baseInstructions: 'ALMA invariants body',
    systemPrompt: 'skill system prompt body',
    instructions: 'step 1 · step 2 · step 3',
  }

  it('an isolated turn carries NO business-domain module', () => {
    const { stable } = buildSystemPromptBlocks({ isolatedSkill: skillArg, forceFullPrompt: true })
    const text = stable.map((b) => b.text).join('')
    expect(findPromptLeaks(text, PROMPT_MODULES)).toEqual([])
  })

  it('a normal turn DOES carry them — so the check above is not vacuous', () => {
    const { stable } = buildSystemPromptBlocks({ forceFullPrompt: true })
    const text = stable.map((b) => b.text).join('')
    expect(findPromptLeaks(text, PROMPT_MODULES).length).toBeGreaterThan(5)
  })

  it('the kernel survives — isolation is not a different agent', () => {
    const { stable } = buildSystemPromptBlocks({ isolatedSkill: skillArg })
    const text = stable.map((b) => b.text).join('')
    for (const m of PROMPT_MODULES.filter((x) => x.core)) {
      expect(text, `core module ${m.id} must survive isolation`).toContain(m.text.trim().slice(0, 80))
    }
  })

  it('the skill body reaches the model, and only once', () => {
    const { stable, volatile } = buildSystemPromptBlocks({
      isolatedSkill: skillArg,
      // A caller that wrongly sends both must still not ship the procedure twice.
      activeSkillsBlock: '### seo-fixing-own-site\nstep 1 · step 2 · step 3',
    })
    const all = [...stable, ...volatile].map((b) => b.text).join('')
    expect(all).toContain('step 1 · step 2 · step 3')
    expect(all.split('step 1 · step 2 · step 3').length - 1).toBe(1)
  })

  it('the isolated prompt is a fraction of the size of the normal one', () => {
    const isolated = buildSystemPromptBlocks({ isolatedSkill: skillArg })
      .stable.map((b) => b.text).join('').length
    const normal = buildSystemPromptBlocks({ forceFullPrompt: true })
      .stable.map((b) => b.text).join('').length
    expect(isolated).toBeLessThan(normal / 3)
  })
})

describe('SK-7 — when isolation does NOT engage', () => {
  afterEach(() => {
    delete process.env.SKILL_ENGINE_ENABLED
    delete process.env.AGENT_SKILL_ISOLATION
    __resetSkillIndexCache()
  })

  it('the flag off keeps the old inline block, nothing isolated', async () => {
    process.env.SKILL_ENGINE_ENABLED = 'true'
    process.env.AGENT_SKILL_ISOLATION = 'off'
    const active = await buildActiveSkills('Boss ajker daily brief ta dao')
    expect(active.isolated).toBeNull()
  })

  it('no conversation pin → no isolation, because the prompt must stay stable', async () => {
    process.env.SKILL_ENGINE_ENABLED = 'true'
    process.env.AGENT_SKILL_ISOLATION = 'on'
    // No conversationId ⇒ per-call selection ⇒ never pinned ⇒ never isolated.
    const active = await buildActiveSkills('almatraders.com er meta description likhe dao')
    expect(active.pinned).toBeNull()
    expect(active.isolated).toBeNull()
  })

  it('the engine off yields nothing at all', async () => {
    const active = await buildActiveSkills('almatraders.com er meta description likhe dao')
    expect(active.isolated).toBeNull()
    expect(active.block).toBe('')
  })
})
