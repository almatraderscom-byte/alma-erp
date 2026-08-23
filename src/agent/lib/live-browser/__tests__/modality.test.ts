import { describe, expect, it } from 'vitest'
import {
  EXPLICIT_CHROME_MODALITY_TOOLS,
  hasExplicitChromeModality,
} from '@/agent/lib/live-browser/modality'

const INCIDENT = 'Amr chrome e dhuke amr website er seo shob gulo page er deeply check koro. Amk report daw'

describe('explicit paired-Chrome modality', () => {
  it('recognises the exact production incident payload independently of the SEO skill', () => {
    expect(hasExplicitChromeModality(INCIDENT)).toBe(true)
    expect(EXPLICIT_CHROME_MODALITY_TOOLS).toEqual([
      'live_browser_pair',
      'live_browser_status',
      'live_browser_look',
      'live_browser_act',
    ])
  })

  it.each([
    'amar Chrome extension API er code fix koro',
    'Chrome integration SDK ta refactor koro',
    'browser automation repository te test add koro',
    'write an API that talks to Chrome DevTools',
  ])('does not turn software/API work into live computer use: %s', (text) => {
    expect(hasExplicitChromeModality(text)).toBe(false)
  })

  it.each([
    'আমার Chrome দিয়ে website-টা খুলে দেখো',
    'amar browser e dhuke page gulo check koro',
    'my Chrome use করে siteটা inspect করো',
  ])('accepts owner-scoped Chrome phrasing: %s', (text) => {
    expect(hasExplicitChromeModality(text)).toBe(true)
  })

  it('does not infer control from a generic Chrome mention', () => {
    expect(hasExplicitChromeModality('Chrome ভালো browser কিনা বলো')).toBe(false)
  })
})
