import { describe, expect, it } from 'vitest'
import {
  buildAgentPresentationV1,
  verificationLabel,
  type BuildPresentationInput,
} from '../build-presentation'

/**
 * Golden fixtures — iOS presentation-parity roadmap §8.
 * These define the ONE canonical visible-block composition both clients must
 * render for the same settled message.
 */

const MSG = 'msg-golden-1'

describe('buildAgentPresentationV1', () => {
  it('simple-final: one final paragraph, no activity', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: 'Boss, আজকের বিক্রি ভালো হয়েছে।' }],
      tokensIn: 100,
      tokensOut: 40,
    })
    expect(p.version).toBe(1)
    expect(p.blocks).toEqual([
      { id: `${MSG}:b0`, type: 'prose', text: 'Boss, আজকের বিক্রি ভালো হয়েছে।', state: 'final' },
    ])
    expect(p.usage).toMatchObject({ tokensIn: 100, tokensOut: 40, totalTokens: 140, apiRounds: 1 })
  })

  it('thinking-tool-final: thinking → tool → final, chronological', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: 'অর্ডারগুলো দেখে নিলাম।' }],
      timeline: [
        { t: 'think', text: 'অর্ডার চেক করা দরকার' },
        { t: 'tool', name: 'get_orders', ok: true, result: '12 orders' },
        { t: 'text', text: 'অর্ডারগুলো দেখে নিলাম।' },
      ],
    })
    expect(p.blocks.map((b) => b.type)).toEqual(['activity', 'activity', 'prose'])
    expect(p.blocks[0]).toMatchObject({ activityType: 'thinking', label: 'অর্ডার চেক করা দরকার' })
    expect(p.blocks[1]).toMatchObject({ activityType: 'tool', toolName: 'get_orders', status: 'done' })
    expect(p.blocks[2]).toMatchObject({ type: 'prose', state: 'final' })
  })

  it('draft-verification-final: draft stays visible, truthfully superseded, one final', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: 'আসলে কাজটা এখনো হয়নি — এখন করে দিচ্ছি।' }],
      timeline: [
        { t: 'text', text: 'কাজটা করে দিয়েছি Boss!', state: 'superseded' },
        { t: 'verify', attempt: 1, max: 2 },
        { t: 'text', text: 'আসলে কাজটা এখনো হয়নি — এখন করে দিচ্ছি।' },
      ],
    })
    expect(p.blocks).toHaveLength(3)
    expect(p.blocks[0]).toMatchObject({ type: 'prose', text: 'কাজটা করে দিয়েছি Boss!', state: 'superseded' })
    expect(p.blocks[1]).toMatchObject({
      type: 'activity',
      activityType: 'verification',
      label: verificationLabel(1, 2),
    })
    expect(p.blocks[2]).toMatchObject({ type: 'prose', state: 'final' })
    // Exactly ONE final block — the superseded draft is never counted as an answer.
    const finals = p.blocks.filter((b) => b.type === 'prose' && b.state === 'final')
    expect(finals).toHaveLength(1)
  })

  it('status-tool-status-final: intentional progress prose stays chronological, never mislabelled final', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      timeline: [
        { t: 'text', text: 'আগে স্টক দেখে নিচ্ছি…' },
        { t: 'tool', name: 'get_inventory_status', ok: true },
        { t: 'text', text: 'এবার দামটা মিলিয়ে দেখছি…' },
        { t: 'tool', name: 'analyze_pricing', ok: true },
        { t: 'text', text: 'Boss, সব মিলিয়ে রিপোর্ট রেডি।' },
      ],
    })
    expect(p.blocks.map((b) => (b.type === 'prose' ? `prose:${b.state}` : b.type))).toEqual([
      'prose:progress',
      'activity',
      'prose:progress',
      'activity',
      'prose:final',
    ])
  })

  it('repeated-content: identical paragraphs keep distinct stable ids and all stay visible', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      timeline: [
        { t: 'text', text: 'একই লাইন।' },
        { t: 'tool', name: 'get_orders', ok: true },
        { t: 'text', text: 'একই লাইন।' },
      ],
    })
    const prose = p.blocks.filter((b) => b.type === 'prose')
    expect(prose).toHaveLength(2)
    expect(new Set(prose.map((b) => b.id)).size).toBe(2)
    expect(prose.map((b) => (b.type === 'prose' ? b.text : ''))).toEqual(['একই লাইন।', 'একই লাইন।'])
  })

  it('usage-four-rounds: cache totals and API-round count pass through exactly', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: 'done' }],
      tokensIn: 1000,
      tokensOut: 200,
      cacheCreation: 5000,
      cacheRead: 20000,
      costUsd: 0.0421,
      apiRounds: 4,
      roundCostsUsd: [0.01, 0.01, 0.012, 0.0101],
    })
    expect(p.usage).toEqual({
      tokensIn: 1000,
      tokensOut: 200,
      cacheCreation: 5000,
      cacheRead: 20000,
      totalTokens: 26200,
      costUsd: 0.0421,
      apiRounds: 4,
      roundCostsUsd: [0.01, 0.01, 0.012, 0.0101],
    })
  })

  it('cards-artifact: confirm + ask + file keep deterministic ordering', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [
        { type: 'text', text: 'অনুমতি দিলে পাঠিয়ে দেব।' },
        { type: 'confirm_card', pendingActionId: 'pa-1' },
        { type: 'ask_card', askCardId: 'ask-1' },
      ],
      timeline: [
        { t: 'tool', name: 'save_artifact', ok: true },
        { t: 'file', id: 'art-1', name: 'SEO রিপোর্ট', kind: 'markdown' },
        { t: 'text', text: 'অনুমতি দিলে পাঠিয়ে দেব।' },
      ],
    })
    expect(p.blocks.map((b) => b.type)).toEqual(['activity', 'file', 'prose', 'confirm_card', 'ask_card'])
    expect(p.blocks[1]).toMatchObject({ artifactId: 'art-1', title: 'SEO রিপোর্ট', kind: 'markdown' })
    expect(p.blocks[3]).toMatchObject({ pendingActionId: 'pa-1' })
    expect(p.blocks[4]).toMatchObject({ askCardId: 'ask-1' })
  })

  it('legacy-no-presentation: old message (no timeline) projects tool rows then final prose', () => {
    const input: BuildPresentationInput = {
      messageId: MSG,
      content: [{ type: 'text', text: 'পুরনো উত্তর।' }],
      toolCalls: [{ id: 't1', name: 'get_orders', success: true, result: 'ok' }],
      tokensIn: 10,
      tokensOut: 5,
    }
    const p = buildAgentPresentationV1(input)
    expect(p.blocks.map((b) => b.type)).toEqual(['activity', 'prose'])
    expect(p.blocks[1]).toMatchObject({ type: 'prose', state: 'final', text: 'পুরনো উত্তর।' })
  })

  it('deterministic: repeated builds are byte-identical', () => {
    const input: BuildPresentationInput = {
      messageId: MSG,
      content: [{ type: 'text', text: 'ঠিক আছে।' }],
      timeline: [
        { t: 'think', text: 'ভাবছি' },
        { t: 'text', text: 'ড্রাফট', state: 'superseded' },
        { t: 'verify', attempt: 1, max: 2 },
        { t: 'text', text: 'ঠিক আছে।' },
      ],
      tokensIn: 1,
      tokensOut: 2,
      apiRounds: 2,
    }
    expect(JSON.stringify(buildAgentPresentationV1(input))).toBe(
      JSON.stringify(buildAgentPresentationV1(input)),
    )
  })

  it('unknown-block-version: unknown timeline entry types are skipped, never fatal', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: 'ok' }],
      timeline: [
        { t: 'hologram', text: 'ভবিষ্যতের ব্লক' },
        { t: 'text', text: 'ok' },
      ],
    })
    expect(p.blocks.map((b) => b.type)).toEqual(['prose'])
    expect(p.blocks[0]).toMatchObject({ state: 'final' })
  })

  it('verification draft without replacement: draft stays superseded, content text is NOT invented as final', () => {
    // Deadline-abort edge: draft superseded, turn died before a replacement.
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [],
      timeline: [
        { t: 'text', text: 'ড্রাফট দাবি', state: 'superseded' },
        { t: 'verify', attempt: 1, max: 2 },
      ],
    })
    expect(p.blocks.map((b) => b.type)).toEqual(['prose', 'activity'])
    expect(p.blocks[0]).toMatchObject({ state: 'superseded' })
    expect(p.blocks.filter((b) => b.type === 'prose' && b.state === 'final')).toHaveLength(0)
  })
})
