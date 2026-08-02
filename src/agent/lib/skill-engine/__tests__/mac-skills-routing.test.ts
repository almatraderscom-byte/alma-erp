/**
 * Tier-1 Mac skills — the routing half.
 *
 * These jobs are named by their OBJECT ("build", "PR", "chat"), and every one of
 * those words is already owned by some other part of the business vocabulary.
 * So each is a RULE, and each rule has to be narrow enough that it never steals
 * a marketing post, an ERP question or an SEO batch.
 *
 * The second half — that the skill exists on the index production actually
 * serves, with the tools it names — is what makes the pin usable at all: a
 * pinned skill hands the turn its own allowlist, so a skill that cannot name a
 * tool cannot use it (feedback_wire_tools_into_prompt, twice live).
 */
import { describe, expect, it } from 'vitest'
import path from 'path'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { applyRules, routeSkill } from '@/agent/lib/skill-engine/router'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

describe('the iPhone release', () => {
  it('routes a TestFlight ask in either script', () => {
    expect(applyRules('testflight build dao')?.skill).toBe('xcode-testflight-shipper')
    expect(applyRules('নতুন টেস্টফ্লাইট বিল্ড দাও')?.skill).toBe('xcode-testflight-shipper')
    expect(applyRules('test flight e notun build pathao')?.skill).toBe('xcode-testflight-shipper')
  })

  it('routes the same ask without the word TestFlight', () => {
    expect(applyRules('iphone app er notun build dao')?.skill).toBe('xcode-testflight-shipper')
    expect(applyRules('ios build koro')?.skill).toBe('xcode-testflight-shipper')
  })

  it('wins over the git rule, because a release says "push" too', () => {
    expect(applyRules('ios build er jonno commit kore push koro')?.skill).toBe(
      'xcode-testflight-shipper',
    )
  })

  it('does not steal an ordinary build word', () => {
    expect(applyRules('npm run build cholao')).toBeNull()
    expect(applyRules('notun campaign build koro')).toBeNull()
  })
})

describe('branch → PR → merge', () => {
  it('routes the git flow verbs', () => {
    expect(applyRules('kaj ta commit kore push koro')?.skill).toBe('git-pr-workflow')
    expect(applyRules('ekta PR banao')?.skill).toBe('git-pr-workflow')
    expect(applyRules('pull request kholo')?.skill).toBe('git-pr-workflow')
    expect(applyRules('PR ta merge koro')?.skill).toBe('git-pr-workflow')
    expect(applyRules('এই কাজটা কমিট করো')?.skill).toBe('git-pr-workflow')
  })

  it('leaves a plain read-only git question to the head', () => {
    expect(applyRules('amar mac e git status cholao')).toBeNull()
    expect(applyRules('kon branch e achi dekho')).toBeNull()
  })
})

describe('the Mac AI apps', () => {
  it('routes app driving', () => {
    expect(applyRules('chatgpt app e eta jigges koro')?.skill).toBe('mac-ai-app-operator')
    expect(applyRules('claude app e ki ache dekho')?.skill).toBe('mac-ai-app-operator')
    expect(applyRules('notun chat khulo')?.skill).toBe('mac-ai-app-operator')
    expect(applyRules('নতুন চ্যাট খোলো')?.skill).toBe('mac-ai-app-operator')
  })

  it('does not hijack Boss talking to the agent itself', () => {
    // No app word: this is him asking ME, not asking the desktop app.
    expect(applyRules('claude ke jiggesh koro')).toBeNull()
    expect(applyRules('ei bishoye tomar mot ki')).toBeNull()
  })
})

describe('nothing else moved', () => {
  it('the existing rules still win their own traffic', () => {
    expect(applyRules('almatraders.com এর ছবির alt ঠিক করো')?.skill).toBe('seo-fixing-own-site')
    expect(applyRules('ei product tar dam 1200 koro')?.skill).toBe('storefront-editing')
    expect(applyRules('Mustahid ajke kokhon asche?')?.skill).toBe('alma-staff-dispatch')
  })

  it('leaves unrelated messages alone', () => {
    expect(applyRules('kalker order gulo dekhao')).toBeNull()
    expect(applyRules('ajker sale koto?')).toBeNull()
  })
})

describe('on the index production actually serves', () => {
  const cases: Array<{ text: string; skill: string; caps: string[] }> = [
    {
      text: 'testflight build dao',
      skill: 'xcode-testflight-shipper',
      caps: ['run_mac_command', 'check_mac_command'],
    },
    {
      text: 'kaj ta commit kore push koro',
      skill: 'git-pr-workflow',
      caps: ['run_mac_command', 'check_mac_command'],
    },
    {
      text: 'chatgpt app e eta jigges koro',
      skill: 'mac-ai-app-operator',
      caps: ['look_mac_app', 'drive_mac_app'],
    },
  ]

  for (const c of cases) {
    it(`${c.skill} is discoverable, wins by rule, and names its tools`, async () => {
      const index = await discoverSkills(SKILLS_ROOT)
      const decision = routeSkill(index, c.text)
      expect(decision.skill).toBe(c.skill)
      expect(decision.layer).toBe('rule')

      const meta = index.skills.find((s) => s.name === c.skill)
      expect(meta, `${c.skill} must be discoverable (status active)`).toBeTruthy()
      for (const cap of c.caps) expect(meta?.requiredCapabilities).toContain(cap)
    })
  }
})
