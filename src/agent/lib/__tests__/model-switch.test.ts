/**
 * Mid-chat head changes — owner ruling 2026-07-26.
 *
 * "same session model change korlew usage accurate even model o nije bujhe ager
 * context ba same jaga thekei shuru kore" — two halves: the meter must stay
 * accurate (usage-intelligence), and the new head must know it is continuing.
 */
import { describe, expect, it } from 'vitest'
import { detectModelSwitch, modelSwitchNote } from '@/agent/lib/model-switch'

describe('detecting the switch', () => {
  it('a genuine change is a switch', () => {
    expect(detectModelSwitch('claude-sonnet-4-6', 'or-deepseek-v4-flash')).toEqual({
      previousModelId: 'claude-sonnet-4-6',
      currentModelId: 'or-deepseek-v4-flash',
    })
  })

  it('the same head is not', () => {
    expect(detectModelSwitch('or-deepseek-v4-flash', 'or-deepseek-v4-flash')).toBeNull()
  })

  it('a first turn is not — there is nothing to continue from', () => {
    expect(detectModelSwitch(null, 'or-deepseek-v4-flash')).toBeNull()
  })
})

describe('what the new head is told', () => {
  const note = modelSwitchNote({
    previousModelId: 'claude-sonnet-4-6',
    currentModelId: 'or-deepseek-v4-flash',
  })

  it('says the history is its to read, and to resume from where work stopped', () => {
    expect(note).toContain('ঠিক যেখানে কাজ থেমেছিল সেখান থেকেই')
  })

  it('forbids the three things a fresh head does wrong', () => {
    expect(note).toContain('নতুন করে পরিচয় দিয়ো না')
    expect(note).toContain('পরিকল্পনা আবার বোলো না')
    expect(note).toContain('আবার কোরো না')
  })

  it('does not make Boss read about engines — he changed it himself', () => {
    expect(note).toContain('Boss-কে ইঞ্জিন বদলের কথা বলার দরকার নেই')
  })

  it('costs nothing when nothing changed', () => {
    expect(modelSwitchNote(null)).toBe('')
  })

  it('stays short — a long note would displace the work it protects', () => {
    expect(note.length).toBeLessThan(700)
  })
})
