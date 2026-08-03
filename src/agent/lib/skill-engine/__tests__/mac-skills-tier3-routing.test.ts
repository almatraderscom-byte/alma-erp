/**
 * Tier-3 Mac skills — routing.
 *
 * These three sit closest to skills that already exist, so the ordering IS the
 * feature: a CLI session is not the desktop app, looking at the app in the
 * Simulator is not shipping it, and "backup" must not be confused with the
 * organizer's tidying.
 */
import { describe, expect, it } from 'vitest'
import path from 'path'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { applyRules, routeSkill } from '@/agent/lib/skill-engine/router'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

describe('a coding session on his Mac', () => {
  it('routes the CLI session asks', () => {
    expect(applyRules('amar mac e ekta claude session kholo')?.skill).toBe('mac-cli-session-runner')
    expect(applyRules('codex session chalao')?.skill).toBe('mac-cli-session-runner')
    expect(applyRules('session ta kholo ar oke bolo kaj ta korte')?.skill)
      .toBe('mac-cli-session-runner')
  })

  it('is not confused with the desktop APP', () => {
    // The GUI app is a different skill with a different tool set.
    expect(applyRules('chatgpt app e eta jigges koro')?.skill).toBe('mac-ai-app-operator')
    expect(applyRules('claude app e ki ache dekho')?.skill).toBe('mac-ai-app-operator')
  })
})

describe('looking at the app in the Simulator', () => {
  it('routes a simulator check', () => {
    expect(applyRules('simulator e app ta dekho')?.skill).toBe('ios-simulator-verifier')
    expect(applyRules('build kore dekho thik ache kina')?.skill).toBe('ios-simulator-verifier')
  })

  // The release rule owns the word "build", and it runs later on purpose: a
  // look is not a ship.
  it('does not become a TestFlight upload', () => {
    expect(applyRules('ios build kore dekho simulator e')?.skill).toBe('ios-simulator-verifier')
    // …but an explicit TestFlight ask still ships.
    expect(applyRules('testflight build dao')?.skill).toBe('xcode-testflight-shipper')
    expect(applyRules('iphone app er notun build dao')?.skill).toBe('xcode-testflight-shipper')
  })
})

describe('is this Mac backed up', () => {
  it('routes the backup questions', () => {
    expect(applyRules('backup ache kina dekho')?.skill).toBe('mac-backup-verifier')
    expect(applyRules('time machine koto din age chalse')?.skill).toBe('mac-backup-verifier')
    expect(applyRules('amar file gulo safe to')?.skill).toBe('mac-backup-verifier')
  })

  // Codex: "backup" is also the production database and the website — those
  // are server-side, and sending a worker to check Time Machine instead is the
  // wrong machine entirely.
  it('does not take a SERVER backup question', () => {
    expect(applyRules('erp database er backup ache to?')).toBeNull()
    expect(applyRules('website er backup koto din por por hoy')).toBeNull()
    expect(applyRules('production db backup dekho')).toBeNull()
  })

  it('does not take tidying or disk-space work', () => {
    expect(applyRules('downloads folder ta porishkar koro')?.skill).toBe('mac-file-organizer')
    expect(applyRules('disk full dekhacche, dekho to')?.skill).toBe('mac-health-monitor')
  })
})

describe('the Mac’s safety settings', () => {
  it('routes the security questions', () => {
    expect(applyRules('amar mac ta secure kina dekho')?.skill).toBe('mac-security-check')
    expect(applyRules('filevault on ache?')?.skill).toBe('mac-security-check')
    expect(applyRules('kono update baki ache kina dekho')?.skill).toBe('mac-security-check')
  })

  // Codex: "update baki ache kina" is just as likely to be the website or the
  // ERP, and the Mac skill's toolset cannot answer that.
  it('does not take a website or ERP update question', () => {
    expect(applyRules('website update baki ache kina')).toBeNull()
    expect(applyRules('erp er security dekho')).toBeNull()
  })

  it('is not the backup skill and not the health one', () => {
    expect(applyRules('backup ache kina dekho')?.skill).toBe('mac-backup-verifier')
    expect(applyRules('disk full dekhacche, dekho to')?.skill).toBe('mac-health-monitor')
  })
})

describe('his day, in one list', () => {
  it('routes the calendar questions', () => {
    expect(applyRules('ajker calendar e ki ache')?.skill).toBe('calendar-reminders-bridge')
    expect(applyRules('reminder gulo dekhao')?.skill).toBe('calendar-reminders-bridge')
    expect(applyRules('ajke kono meeting ache?')?.skill).toBe('calendar-reminders-bridge')
  })

  it('leaves the business questions to the business tools', () => {
    expect(applyRules('kalker order gulo dekhao')).toBeNull()
    expect(applyRules('ajker sale koto?')).toBeNull()
  })
})

describe('nothing earlier moved', () => {
  it('Tiers 1 and 2 keep their traffic', () => {
    expect(applyRules('kaj ta commit kore push koro')?.skill).toBe('git-pr-workflow')
    expect(applyRules('screenshot dao')?.skill).toBe('screenshot-annotate-share')
    expect(applyRules('gato masher invoice pdf ta khujo')?.skill).toBe('spotlight-finder')
    expect(applyRules('ei video ta choto koro, pathano jacche na')?.skill).toBe('media-transcoder')
    expect(applyRules('ei product tar dam 1200 koro')?.skill).toBe('storefront-editing')
  })
})

describe('on the index production actually serves', () => {
  const cases: Array<{ text: string; skill: string; caps: string[] }> = [
    {
      text: 'amar mac e ekta claude session kholo',
      skill: 'mac-cli-session-runner',
      caps: ['start_cli_session', 'read_cli_session'],
    },
    {
      text: 'simulator e app ta dekho',
      skill: 'ios-simulator-verifier',
      caps: ['run_mac_command', 'mac_desk_control'],
    },
    { text: 'backup ache kina dekho', skill: 'mac-backup-verifier', caps: ['run_mac_command'] },
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
