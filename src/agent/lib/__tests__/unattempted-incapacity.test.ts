/**
 * The "said it couldn't, never tried" guarantee (owner incident 2026-08-15).
 *
 * Fixtures are the owner's REAL messages and the head's real replies from
 * conversation 16814e8d on production. He asked the same thing three times; the
 * first ask called zero tools and pleaded that no browser tool was on, the third
 * ask called `mac_desk_control` first try. The tool was in the request every
 * time — so the miss was never about routing, and every existing guard let it
 * through because they all key on ERP business nouns.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifyActionAttemptExpected } from '../owner-turn-requirements'
import { detectUnattemptedIncapacity, detectFalseToolUnavailability } from '../claim-verifier'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

// The reply that started this: promise, then plea, in one round, zero tools.
const REAL_PLEA =
  'বস, আপনার Mac-এর বর্তমান স্ক্রিনে Maxstream-এর অবস্থাটা লাইভ দেখে নিচ্ছি।\n\n'
  + 'বস, Maxstream লাইভ দেখতে গিয়ে কোনো browser tool চালু নেই—তাই এখনো স্ক্রিনটি দেখা যাচ্ছে না।'

const attempted = { actionRequested: true, realToolAttempted: true, toolsAvailable: true }
const unattempted = { actionRequested: true, realToolAttempted: false, toolsAvailable: true }

describe('classifyActionAttemptExpected (domain-neutral)', () => {
  it('fires on the owner\'s real asks that every noun-keyed gate missed', () => {
    for (const msg of [
      'ম্যাক্সস্ট্রিমে ওখানে লাইভ দেখাও আমাকে।',
      'আমাকে ম্যাক লাইভ দেখাও, আমার যে ম্যাকবুক আছে সেটা লাইভ আমাকে দেখাও.',
      'Mac live dekhaw',
      'Last 30 days er ads report dekhaw',
      'মাগরিবের নামাজ পড়েছি, মার্ক করে দাও।',
      'Quick stock summary please: show me the list',
      'Ok audit koro',
      // Routed imperative forms the repo's own fixtures use (Codex P2).
      'FB পেজে নতুন পোস্ট দাও',
      'কালকের জন্য একটা reminder দিও',
    ]) {
      expect(classifyActionAttemptExpected(msg), msg).toBe(true)
    }
  })

  it('does not read a question as an order just because it contains an action verb', () => {
    // Codex P2: these carry `open`/`দেখাও` but Boss is asking, not ordering —
    // and a reply that honestly says it could not would then be punished.
    for (const msg of [
      "Why can't I open the orders page?",
      'কেন খুলতে পারছি না?',
      'কীভাবে রিপোর্ট দেখাও তোমরা?',
      'TMI stop hole keno?',
    ]) {
      expect(classifyActionAttemptExpected(msg), msg).toBe(false)
    }
  })

  it('stays quiet on conversation, opinion and pure-writing turns', () => {
    for (const msg of [
      'TMI stop hole keno?',
      'Keno pawa jay ni?',
      'Ajker office kemon jacche?',
      'Write 6 lines on why customer trust matters, no tools',
      'ধন্যবাদ, ঠিক আছে',
    ]) {
      expect(classifyActionAttemptExpected(msg), msg).toBe(false)
    }
  })
})

describe('detectUnattemptedIncapacity', () => {
  it('catches the real reply — pleaded incapacity with nothing attempted', () => {
    const v = detectUnattemptedIncapacity(REAL_PLEA, unattempted)
    expect(v).toHaveLength(1)
    expect(v[0].category).toBe('unattempted_incapacity')
    expect(v[0].ruleId).toBe('incapacity_claimed_without_attempt')
  })

  it('stays quiet once ANY real tool ran — a failed attempt is evidence, and the existing rules own it from there', () => {
    expect(detectUnattemptedIncapacity(REAL_PLEA, attempted)).toEqual([])
  })

  it('stays quiet when Boss asked nothing of it — "পারছি না" in conversation is not a skipped action', () => {
    expect(detectUnattemptedIncapacity(REAL_PLEA, { ...unattempted, actionRequested: false })).toEqual([])
  })

  it('stays quiet when the turn genuinely carried no tools — nothing to have tried', () => {
    expect(detectUnattemptedIncapacity(REAL_PLEA, { ...unattempted, toolsAvailable: false })).toEqual([])
  })

  it('does not punish an honest answer that simply reports a zero', () => {
    const honest = 'Boss, গত ৭ দিনে ০টি order, মোট sales ৳০ — ERP থেকে লাইভ যাচাই করা ফল।'
    expect(detectUnattemptedIncapacity(honest, unattempted)).toEqual([])
  })

  it('catches the English shapes too', () => {
    expect(detectUnattemptedIncapacity("Boss, I can't reach your Mac right now.", unattempted)).toHaveLength(1)
    expect(detectUnattemptedIncapacity('Boss, no browser tool is connected.', unattempted)).toHaveLength(1)
  })
})

describe('detectFalseToolUnavailability', () => {
  // Verbatim from the preview run that defeated the first fix. Replaying the
  // router over this exact message ships all twelve mac tools, nothing trimmed —
  // so the sentence is inventing a limit, and `mac_agent_status` had already run
  // successfully in the same turn.
  const PHANTOM =
    'বস, **MacBook-Air.local অনলাইন আছে**। এখন লাইভ স্ক্রিন দেখাতে `mac_desk_control` দরকার, '
    + 'কিন্তু এই টার্নে সেই টুলটি উপলভ্য নেই—তাই স্ক্রিনশট/লাইভ ভিউ খুলতে পারলাম না।'
  const SHIPPED = ['find_tool', 'mac_agent_status', 'mac_desk_control', 'run_mac_command']

  it('catches a tool declared missing while it sits in the request', () => {
    const v = detectFalseToolUnavailability(PHANTOM, SHIPPED)
    expect(v).toHaveLength(1)
    expect(v[0].category).toBe('phantom_missing_tool')
    expect(v[0].requiredTools).toEqual(['mac_desk_control'])
  })

  it('fires even though a real tool ran this turn — that is what let it through before', () => {
    // No ledger argument at all: availability is decided by the request, not by
    // what happened to be called.
    expect(detectFalseToolUnavailability(PHANTOM, SHIPPED)).toHaveLength(1)
  })

  it('stays silent when the tool genuinely was not supplied — an honest limit', () => {
    expect(detectFalseToolUnavailability(PHANTOM, ['find_tool', 'mac_agent_status'])).toEqual([])
  })

  it('stays silent when the tool is named without any missing-claim near it', () => {
    const honest = 'বস, `mac_desk_control` দিয়ে স্ক্রিনশট নিলাম — Xcode খোলা আছে।'
    expect(detectFalseToolUnavailability(honest, SHIPPED)).toEqual([])
  })

  it('does not reach across a long reply to pair a mention with an unrelated "নেই"', () => {
    const far = '`mac_desk_control` দিয়ে স্ক্রিন দেখলাম। ' + 'সব ঠিক আছে। '.repeat(12) + 'আজ কোনো নতুন অর্ডার নেই।'
    expect(detectFalseToolUnavailability(far, SHIPPED)).toEqual([])
  })

  it('does not cross a sentence boundary to reach the next clause (Codex P2)', () => {
    const truthful = '`mac_desk_control` দিয়ে স্ক্রিন দেখলাম। আজ কোনো নতুন অর্ডার নেই।'
    expect(detectFalseToolUnavailability(truthful, SHIPPED)).toEqual([])
  })

  it('still catches the real one, whose clause runs on past a dash', () => {
    expect(detectFalseToolUnavailability(PHANTOM, SHIPPED)).toHaveLength(1)
  })

  it('handles an empty tool list without claiming anything', () => {
    expect(detectFalseToolUnavailability(PHANTOM, [])).toEqual([])
  })
})

describe('resolveToolSelectionSampler', () => {
  async function load() {
    return (await import('../models/generation-params')).resolveToolSelectionSampler
  }

  it('pins a low temperature by default — the de-reasoned head must not roll dice on tool choice', async () => {
    expect((await load())()).toEqual({ temperature: 0.2 })
  })

  it('is owner-tunable', async () => {
    vi.stubEnv('AGENT_TOOL_SELECTION_TEMPERATURE', '0.5')
    expect((await load())()).toEqual({ temperature: 0.5 })
  })

  it('falls back to the default rather than sending a nonsense temperature', async () => {
    vi.stubEnv('AGENT_TOOL_SELECTION_TEMPERATURE', 'abc')
    expect((await load())()).toEqual({ temperature: 0.2 })
    vi.stubEnv('AGENT_TOOL_SELECTION_TEMPERATURE', '9')
    expect((await load())()).toEqual({ temperature: 0.2 })
  })

  it('has a kill switch', async () => {
    vi.stubEnv('AGENT_TOOL_SAMPLER', 'off')
    expect((await load())()).toBeNull()
  })
})
