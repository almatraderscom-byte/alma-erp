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

  it('draft-verification-final: superseded draft stays audit-only, one visible final', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: 'আসলে কাজটা এখনো হয়নি — এখন করে দিচ্ছি।' }],
      timeline: [
        { t: 'text', text: 'কাজটা করে দিয়েছি Boss!', state: 'superseded' },
        { t: 'verify', attempt: 1, max: 2 },
        { t: 'text', text: 'আসলে কাজটা এখনো হয়নি — এখন করে দিচ্ছি।' },
      ],
    })
    expect(p.blocks).toHaveLength(2)
    expect(p.blocks[0]).toMatchObject({
      type: 'activity',
      activityType: 'verification',
      label: verificationLabel(1, 2),
    })
    expect(p.blocks[1]).toMatchObject({
      type: 'prose',
      text: 'আসলে কাজটা এখনো হয়নি — এখন করে দিচ্ছি।',
      state: 'final',
    })
    expect(p.blocks.filter((b) => b.type === 'prose')).toHaveLength(1)
    // Additive selfCorrected marker — drives the clients' "নিজে যাচাই করে
    // ঠিক করেছে" badge from the canonical payload.
    expect(p.selfCorrected).toBe(true)
  })

  it('selfCorrected: absent when no verification/superseded entry exists', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: 'সব ঠিক আছে Boss।' }],
      timeline: [
        { t: 'think', text: 'সরাসরি উত্তর দিই' },
        { t: 'text', text: 'সব ঠিক আছে Boss।' },
      ],
    })
    expect(p.selfCorrected).toBeUndefined()
  })

  it('status-tool-status-final: progress prose stays audit-only and one final remains visible', () => {
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
      'activity',
      'activity',
      'prose:final',
    ])
    expect(p.blocks[2]).toMatchObject({ type: 'prose', text: 'Boss, সব মিলিয়ে রিপোর্ট রেডি।' })
  })

  it('repeated-content: repeated progress/final text produces one visible reply', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      timeline: [
        { t: 'text', text: 'একই লাইন।' },
        { t: 'tool', name: 'get_orders', ok: true },
        { t: 'text', text: 'একই লাইন।' },
      ],
    })
    const prose = p.blocks.filter((b) => b.type === 'prose')
    expect(prose).toHaveLength(1)
    expect(prose[0]).toMatchObject({ type: 'prose', text: 'একই লাইন।', state: 'final' })
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

  it('verification draft without replacement: unverified prose is never owner-visible', () => {
    // Deadline-abort edge: draft superseded, turn died before a replacement.
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [],
      timeline: [
        { t: 'text', text: 'ড্রাফট দাবি', state: 'superseded' },
        { t: 'verify', attempt: 1, max: 2 },
      ],
    })
    expect(p.blocks.map((b) => b.type)).toEqual(['activity'])
    expect(p.blocks.filter((b) => b.type === 'prose')).toHaveLength(0)
  })

  it('real regression shape: accumulated stored progress still projects only the final timeline reply', () => {
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: 'আগে setup করছি।\n\nBoss, setup শেষ।' }],
      timeline: [
        { t: 'text', text: 'ভুল draft', state: 'superseded' },
        { t: 'verify', attempt: 1, max: 2 },
        { t: 'text', text: 'আগে setup করছি।' },
        { t: 'tool', name: 'live_browser_look', ok: true },
        { t: 'text', text: 'Boss, setup শেষ।' },
      ],
    })

    expect(p.blocks.filter((b) => b.type === 'prose')).toEqual([
      { id: `${MSG}:b2`, type: 'prose', text: 'Boss, setup শেষ।', state: 'final' },
    ])
    expect(p.selfCorrected).toBe(true)
  })

  it('deadline suffix: preserves stored continuation detail absent from the timeline', () => {
    const final = 'Boss, কাজটা এই ধাপ পর্যন্ত হয়েছে।'
    const footer = '📌 “continue” বললে এখান থেকে চালাব।'
    const p = buildAgentPresentationV1({
      messageId: MSG,
      content: [{ type: 'text', text: `${final}\n\n${footer}` }],
      timeline: [{ t: 'text', text: final }],
    })

    expect(p.blocks.filter((b) => b.type === 'prose')).toEqual([
      { id: `${MSG}:b0`, type: 'prose', text: `${final}\n\n${footer}`, state: 'final' },
    ])
  })
})
