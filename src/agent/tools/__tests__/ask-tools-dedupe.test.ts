import { describe, expect, it } from 'vitest'
import { currentOwnerRequestText, shouldCreateAskCard } from '../ask-tools'

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

  it('treats explicit do-not-paste/post wording as a prohibition', () => {
    expect(shouldCreateAskCard({
      ownerText: 'Family matching carousel-এর detailed primary text লিখে দাও; কোথাও paste বা post কোরো না।',
      question: 'Boss, primary text Ready। এখন কী করব?',
      options: ['Ads Manager-এ paste করো', 'Edit করতে চাই', 'রেখে দিন'],
    })).toBe(false)
  })

  it('still recognizes an affirmative publish request', () => {
    expect(shouldCreateAskCard({
      ownerText: 'Family matching caption লিখে তারপর Facebook-এ post করো',
      question: 'কোন page-এ post করব?',
      options: ['ALMA Lifestyle', 'ALMA Trading'],
    })).toBe(true)
  })

  it('combines the base request with every update for the same running turn', () => {
    const targetTurnId = 'turn-1'
    const text = currentOwnerRequestText([
      {
        id: 'steer-2',
        createdAt: new Date('2026-07-21T10:00:03Z'),
        content: [{ type: 'text', text: 'emoji ব্যবহার কোরো না' }],
        usage: { steering: { targetTurnId } },
      },
      {
        id: 'steer-1',
        createdAt: new Date('2026-07-21T10:00:02Z'),
        content: [{ type: 'text', text: '৮টির বদলে ৩টি করো' }],
        usage: { steering: { targetTurnId } },
      },
      {
        id: 'base',
        createdAt: new Date('2026-07-21T10:00:01Z'),
        content: [{ type: 'text', text: '৮টি primary text idea লিখে দাও' }],
      },
      {
        id: 'old',
        createdAt: new Date('2026-07-21T09:00:00Z'),
        content: [{ type: 'text', text: 'পুরোনো unrelated request' }],
      },
    ])
    expect(text).toBe('৮টি primary text idea লিখে দাও\n৮টির বদলে ৩টি করো\nemoji ব্যবহার কোরো না')
  })
})
