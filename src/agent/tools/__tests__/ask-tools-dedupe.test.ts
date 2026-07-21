import { describe, expect, it } from 'vitest'
import { shouldCreateAskCard } from '../ask-tools'

describe('ask_user clarification boundary', () => {
  it('rejects the screenshot flow: write caption here → asks to paste elsewhere', () => {
    expect(shouldCreateAskCard({
      ownerText: 'Primary text er jonne amk best details caption ekhane likhe daw',
      question: 'Caption টা কেমন লাগলো? Ads Manager-এ paste করব?',
    })).toBe(false)
  })

  it('keeps a material clarification before work', () => {
    expect(shouldCreateAskCard({
      ownerText: 'family matching caption লিখে দাও',
      question: 'কোন collection-এর product family match করব?',
    })).toBe(true)
  })
})
