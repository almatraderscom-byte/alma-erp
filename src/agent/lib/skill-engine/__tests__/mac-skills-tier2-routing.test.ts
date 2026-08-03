/**
 * Tier-2 Mac skills — routing.
 *
 * Same discipline as Tier 1, and the same hazard: every one of these jobs is
 * named with a word the business already uses. "khujo" is how Boss asks for
 * market research; "banao" is how he asks for a poster; "folder" appears in
 * half the Mac sentences there are. So each rule carries its veto, and the
 * vetoes are what these tests are mostly about.
 */
import { describe, expect, it } from 'vitest'
import path from 'path'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { applyRules, routeSkill } from '@/agent/lib/skill-engine/router'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

describe('the Mac’s own health', () => {
  it('routes the machine questions', () => {
    expect(applyRules('amar mac ta khub slow hoye geche')?.skill).toBe('mac-health-monitor')
    expect(applyRules('disk full dekhacche, dekho to')?.skill).toBe('mac-health-monitor')
    expect(applyRules('jayga nei bolche mac e')?.skill).toBe('mac-health-monitor')
    expect(applyRules('battery koto ache')?.skill).toBe('mac-health-monitor')
  })

  it('leaves business "slow" alone', () => {
    expect(applyRules('ajke sale slow keno')).toBeNull()
    expect(applyRules('website ta slow hoye geche')).toBeNull()
  })
})

describe('finding a file', () => {
  it('routes a search for something on the disk', () => {
    expect(applyRules('gato masher invoice pdf ta khujo')?.skill).toBe('spotlight-finder')
    expect(applyRules('sei file ta kothay ache')?.skill).toBe('spotlight-finder')
    expect(applyRules('chukti r document ta pacchi na')?.skill).toBe('spotlight-finder')
  })

  it('does not take a web or ERP search', () => {
    // "khujo" is also how he asks for market research and for orders.
    expect(applyRules('competitor der dam khujo')).toBeNull()
    expect(applyRules('oi customer er order ta khujo')).toBeNull()
    expect(applyRules('google e khuje dekho')).toBeNull()
  })
})

describe('converting media', () => {
  it('routes a shrink / trim / extract', () => {
    expect(applyRules('ei video ta choto koro, pathano jacche na')?.skill).toBe('media-transcoder')
    expect(applyRules('video theke audio ber koro')?.skill).toBe('media-transcoder')
    expect(applyRules('chobi gulo resize koro')?.skill).toBe('media-transcoder')
  })

  it('does not steal Creative Studio’s job', () => {
    // MAKING media is a different program entirely.
    expect(applyRules('ekta product video banao')).toBeNull()
    expect(applyRules('notun poster design koro')).toBeNull()
  })
})

describe('Tier 1 still owns its own traffic', () => {
  it('nothing moved', () => {
    expect(applyRules('downloads folder ta porishkar koro')?.skill).toBe('mac-file-organizer')
    expect(applyRules('screenshot dao')?.skill).toBe('screenshot-annotate-share')
    expect(applyRules('testflight build dao')?.skill).toBe('xcode-testflight-shipper')
    expect(applyRules('kaj ta commit kore push koro')?.skill).toBe('git-pr-workflow')
    expect(applyRules('chatgpt app e eta jigges koro')?.skill).toBe('mac-ai-app-operator')
  })

  it('and the business rules are untouched', () => {
    expect(applyRules('ei product tar dam 1200 koro')?.skill).toBe('storefront-editing')
    expect(applyRules('kalker order gulo dekhao')).toBeNull()
  })
})

describe('on the index production actually serves', () => {
  const cases: Array<{ text: string; skill: string; caps: string[] }> = [
    { text: 'amar mac ta khub slow hoye geche', skill: 'mac-health-monitor', caps: ['run_mac_command'] },
    { text: 'gato masher invoice pdf ta khujo', skill: 'spotlight-finder', caps: ['run_mac_command'] },
    {
      text: 'ei video ta choto koro, pathano jacche na',
      skill: 'media-transcoder',
      caps: ['run_mac_command', 'check_mac_command'],
    },
  ]

  for (const c of cases) {
    it(`${c.skill} is discoverable, wins by rule, and names its tools`, async () => {
      const index = await discoverSkills(SKILLS_ROOT)
      const decision = routeSkill(index, c.text)
      expect(decision.skill).toBe(c.skill)
      expect(decision.layer).toBe('rule')
      const meta = index.skills.find((s) => s.name === c.skill)
      expect(meta, `${c.skill} must be discoverable`).toBeTruthy()
      for (const cap of c.caps) expect(meta?.requiredCapabilities).toContain(cap)
    })
  }
})
