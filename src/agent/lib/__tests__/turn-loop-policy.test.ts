import { describe, expect, it } from 'vitest'
import {
  shouldNudgeAdapterIntent,
  shouldRestartHeadAfterFailure,
  shouldNudgeZeroToolIntent,
} from '../turn-loop-policy'

describe('turn-loop policy — no hidden duplicate work', () => {
  it('does not turn an owner-directed question into another execution', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'ALMA Companion থেকে এখন কোনো heartbeat পাচ্ছি না। আর কিছু করব কি?',
      toolRecords: [{ status: 'error' }],
      ownerRequestedAction: false,
    })).toBe(false)
  })

  it('stops after any honest blocked/offline response', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'Chrome এখন offline, তাই কাজটি করতে পারিনি। আবার চেষ্টা করব।',
      toolRecords: [{ status: 'error' }],
      ownerRequestedAction: true,
    })).toBe(false)
  })

  it('stops after the latest tool failed even when the wording promises action', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'এখন অন্যভাবে চেষ্টা করব।',
      toolRecords: [{ status: 'success' }, { status: 'error' }],
      ownerRequestedAction: true,
    })).toBe(false)
  })

  it('allows one real next-step nudge after a successful tool', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'প্রথম পেজ দেখা হয়েছে। এখন Manual destination সিলেক্ট করব।',
      toolRecords: [{ status: 'success' }],
      ownerRequestedAction: true,
    })).toBe(true)
  })

  it('does not nudge when an ask card already hands control to the owner', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'অনুমতি পেলে পরের ধাপ করব।',
      toolRecords: [{ status: 'success' }],
      hasAskCard: true,
      ownerRequestedAction: true,
    })).toBe(false)
  })

  it('applies the same question/failure rule to the zero-tool head path', () => {
    expect(shouldNudgeZeroToolIntent({ text: 'আমি আগে চেক করি—আপনি চান কি?', ownerRequestedAction: false })).toBe(false)
    expect(shouldNudgeZeroToolIntent({ text: 'সংযোগ নেই, তাই চেক করতে পারছি না।', ownerRequestedAction: true })).toBe(false)
    expect(shouldNudgeZeroToolIntent({ text: 'একটু দাঁড়ান, let me check the record.', ownerRequestedAction: true })).toBe(true)
  })

  it('does not replay the exact office-status incident as a hidden owner turn', () => {
    const text =
      '**বস, অফিস আজ খুবই slow চলছে।**\n\n' +
      'আজ শেষ: ০টা, খোলা ৪১টা। পরের ধাপে নতুন proposal রেডি করব কি? ' +
      '(Eyafi-কে ১০+ reels focus, Mustahid-কে সহজ step-by-step)'

    expect(shouldNudgeAdapterIntent({
      text,
      toolRecords: [{ status: 'success' }],
      ownerRequestedAction: false,
    })).toBe(false)
    // Even an action turn must stop when the model hands control back via a
    // question followed by parenthetical detail.
    expect(shouldNudgeAdapterIntent({
      text,
      toolRecords: [{ status: 'success' }],
      ownerRequestedAction: true,
    })).toBe(false)
  })

  it('allows a head restart only before any work or owner-facing output', () => {
    expect(shouldRestartHeadAfterFailure({
      text: '',
      toolRecords: [],
    })).toBe(true)

    expect(shouldRestartHeadAfterFailure({
      text: '',
      toolRecords: [{ status: 'success' }],
    })).toBe(false)

    expect(shouldRestartHeadAfterFailure({
      text: '',
      toolRecords: [{ status: 'error' }],
    })).toBe(false)

    expect(shouldRestartHeadAfterFailure({
      text: 'কাজ শুরু করেছি।',
      toolRecords: [],
    })).toBe(false)

    expect(shouldRestartHeadAfterFailure({
      text: '',
      toolRecords: [],
      hasAskCard: true,
    })).toBe(false)
  })
})

describe('a read-only turn that ran NO tool must not end on an announcement', () => {
  // Owner hit this live on the preview 2026-07-25: the reply was exactly
  // "বস, … সঠিক ফোন নম্বর বের করতে list_family_contacts চালাচ্ছি।" and the turn
  // ended there. `ownerRequestedAction` was false (a read question), so the
  // guard exempted it.
  it('nudges when zero tools ran, even without a mutation intent', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'বস, সঠিক ফোন নম্বর বের করতে list_family_contacts চালাচ্ছি।',
      toolRecords: [],
      ownerRequestedAction: false,
    })).toBe(true)
  })

  it('still exempts a finished read turn that already used a tool', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'বস, আজ ৫টা অর্ডার পেন্ডিং। পরের ধাপে dispatch দেখব।',
      toolRecords: [{ status: 'success' }],
      ownerRequestedAction: false,
    })).toBe(false)
  })

  it('still respects the terminal-reply guards (question / failure)', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'বস, এখনই চালাব কি?',
      toolRecords: [],
      ownerRequestedAction: false,
    })).toBe(false)
    expect(shouldNudgeAdapterIntent({
      text: 'বস, চালাতে পারিনি — সংযোগ নেই।',
      toolRecords: [],
      ownerRequestedAction: false,
    })).toBe(false)
  })
})

describe('a failure REPORT that also names the next attempt is not terminal', () => {
  // Found 2026-07-25 by testing a staff-dispatch request instead of repeating
  // the same ads question: prepare_staff_task_proposal failed, the head said
  // "…ব্যর্থ — আগে get_staff_tasks দিয়ে দেখে নিচ্ছি।" and the turn ended on it.
  it('nudges when the head reports a failure AND announces a different next step', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'বস, প্রস্তাব টুল ব্যর্থ হয়েছে invalid task type — আগে get_staff_tasks দিয়ে কালকের carried tasks দেখে নিচ্ছি।',
      toolRecords: [{ status: 'error' }],
      ownerRequestedAction: true,
    })).toBe(true)
  })

  it('still stops on a bare failure report with no next step', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'বস, পারিনি — সংযোগ নেই, অনুমতি লাগবে।',
      toolRecords: [{ status: 'error' }],
      ownerRequestedAction: true,
    })).toBe(false)
  })

  it('still stops when the failure report ends by asking Boss', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'বস, টুল ব্যর্থ — আবার চেষ্টা করব কি?',
      toolRecords: [{ status: 'error' }],
      ownerRequestedAction: true,
    })).toBe(false)
  })
})
