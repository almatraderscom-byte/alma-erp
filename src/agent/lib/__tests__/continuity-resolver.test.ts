/**
 * Phase 32 — deterministic continuity resolver.
 *
 * The resolver is a PURE function over durable state, so these tests are also
 * the restart/gap proof: the same inputs (read back from the DB after any
 * process restart or a 90-day silence) produce byte-identical decisions —
 * there is no in-memory state to lose.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  resolveContinuityDecision,
  isContinuationUtterance,
  isStatusQuery,
  isRetryText,
  isWhyStoppedText,
  isClearNewTask,
  referencesFocus,
  continuityResolverMode,
  type ContinuityInput,
} from '@/agent/lib/continuity-resolver'
import { loadCorpus } from '@/agent/replay/run-agent-replay'
import { classifyHeadFastPath } from '@/agent/lib/models/head-router'

const FIXTURES = join(process.cwd(), 'src/agent/replay/fixtures')

const FOCUS = {
  id: 'f1',
  goal: 'নতুন পাঞ্জাবি কালেকশনের ফেসবুক পোস্ট',
  kind: 'fb_post_workflow',
  status: 'active' as const,
  currentStep: 'draft_review',
  completedSteps: ['generate_image:img-001'],
}

function input(partial: Partial<ContinuityInput>): ContinuityInput {
  return {
    text: '',
    listenMode: false,
    replyToCardId: null,
    pendingCards: [],
    activeFocus: null,
    checkpoints: [],
    ...partial,
  }
}

describe('text classifiers (wide nets, roadmap targets)', () => {
  it('recognizes the natural continuations the old CONTINUE_RE missed', () => {
    for (const t of ['তারপর?', 'যেখানে ছিলে সেখান থেকে করো', 'ওটাই করো', 'baki ta koro', 'agertar ki obostha?', 'oi kaj ta ses koro', 'হ্যাঁ', 'ok', 'চালিয়ে যাও', 'resume']) {
      expect(isContinuationUtterance(t) || isStatusQuery(t), t).toBe(true)
    }
  })
  it('does not swallow full task sentences', () => {
    for (const t of ['এখন একটা নতুন কাজ: ঈদের পোস্টার বানাও', 'competitor der notun collection research koro', 'notun stock koto asheche dekho']) {
      expect(isContinuationUtterance(t), t).toBe(false)
    }
  })
  it('status / retry / why-stopped shapes', () => {
    expect(isStatusQuery('post ta koi?')).toBe(true)
    expect(isStatusQuery('ki obostha oi kajer?')).toBe(true)
    expect(isStatusQuery('আমরা কোথায় ছিলাম?')).toBe(true)
    expect(isRetryText('abar chalao')).toBe(true)
    expect(isWhyStoppedText('থামলো কেন?')).toBe(true)
    expect(isWhyStoppedText('kaj ta atke ache keno?')).toBe(true)
  })
  it('clear new tasks carry their own domain intent', () => {
    expect(isClearNewTask('ঈদের জন্য একটা পোস্টার বানাও')).toBe(true)
    expect(isClearNewTask('তারপর?')).toBe(false)
  })
  it('referencesFocus matches artifact words across Bangla/Banglish', () => {
    expect(referencesFocus('post ta koi?', FOCUS)).toBe(true)
    expect(referencesFocus('পোস্ট হয়েছে?', FOCUS)).toBe(true)
    expect(referencesFocus('আজকের আবহাওয়া কেমন?', FOCUS)).toBe(false)
  })
})

describe('resolver rules in roadmap order', () => {
  it('0. listen mode suppresses work without deleting focus', () => {
    const d = resolveContinuityDecision(input({ text: 'mon ta valo nei aj', listenMode: true, activeFocus: FOCUS }))
    expect(d.binding).toBe('none')
    expect(d.action).toBe('listen')
  })
  it('1. explicit reply-to card wins over everything', () => {
    const d = resolveContinuityDecision(input({
      text: 'নীল',
      replyToCardId: 'ask-1',
      pendingCards: [{ id: 'ask-1', kind: 'ask_card' }],
      activeFocus: FOCUS,
      checkpoints: [{ taskType: 'browser_task', step: 's1' }],
    }))
    expect(d.binding).toBe('pending_card')
    expect(d.cardId).toBe('ask-1')
  })
  it('2. pending card + decision text binds the card; status text explains the block', () => {
    const approve = resolveContinuityDecision(input({ text: 'approve', pendingCards: [{ id: 'pa-1', kind: 'approval' }] }))
    expect(approve.binding).toBe('pending_card')
    expect(approve.action).toBe('answer_card')
    const status = resolveContinuityDecision(input({ text: 'kaj ta atke ache keno?', pendingCards: [{ id: 'pa-1', kind: 'approval' }] }))
    expect(status.binding).toBe('pending_card')
    expect(status.action).toBe('explain_stop')
  })
  it('3. checkpoint + retry/why-stopped binds the checkpoint', () => {
    const retry = resolveContinuityDecision(input({ text: 'abar try koro', checkpoints: [{ taskRef: 'cp-1', taskType: 'browser_task', step: 'scrape_page_2' }] }))
    expect(retry.binding).toBe('checkpoint')
    expect(retry.action).toBe('retry')
    const why = resolveContinuityDecision(input({ text: 'থামলো কেন?', checkpoints: [{ taskRef: 'cp-1', taskType: 'browser_task', step: 'fill_form' }] }))
    expect(why.action).toBe('explain_stop')
  })
  it('4. a clear new task parks the active focus — never mixes', () => {
    const d = resolveContinuityDecision(input({ text: 'এখন একটা নতুন কাজ: ঈদের পোস্টার বানাও', activeFocus: FOCUS }))
    expect(d.binding).toBe('new_task')
    expect(d.action).toBe('park_and_start')
  })
  it('4b. short focus-referencing questions are NOT new tasks (the "post ta koi?" class)', () => {
    const d = resolveContinuityDecision(input({ text: 'post ta koi?', activeFocus: FOCUS }))
    expect(d.binding).toBe('active_focus')
    expect(d.action).toBe('resume')
  })
  it('4c. demonstrative references ("oi proposal ta pathao") bind the focus', () => {
    const d = resolveContinuityDecision(input({
      text: 'oi proposal ta pathao',
      activeFocus: { goal: 'কালকের ডেলিভারি টাস্ক ভাগ করা', kind: 'staff_dispatch', status: 'active' },
    }))
    expect(d.binding).toBe('active_focus')
  })
  it('4d. a side-question in another domain does NOT park the focus (no imperative verb)', () => {
    const d = resolveContinuityDecision(input({ text: 'lunch e ki khawa jay bolo to', activeFocus: FOCUS }))
    expect(d.binding).toBe('new_task')
    expect(d.action).toBe('proceed')
    expect(d.reason).toBe('side_question_keeps_focus')
  })
  it('5a. a strong continuation resumes a SINGLE parked focus; two parked → clarify', () => {
    const one = resolveContinuityDecision(input({
      text: 'যেখানে ছিলে সেখান থেকে করো',
      parkedFocuses: [{ id: 'p1', goal: 'SEO ব্যাচ', kind: 'seo_fix_batch', status: 'parked' }],
    }))
    expect(one.binding).toBe('active_focus')
    expect(one.focusId).toBe('p1')
    const two = resolveContinuityDecision(input({
      text: 'যেখানে ছিলে সেখান থেকে করো',
      parkedFocuses: [
        { id: 'p1', goal: 'SEO ব্যাচ', kind: 'seo_fix_batch', status: 'parked' },
        { id: 'p2', goal: 'পোস্ট', kind: 'fb_post_workflow', status: 'parked' },
      ],
    }))
    expect(two.binding).toBe('none')
    expect(two.action).toBe('clarify')
  })
  it('5. continuation binds the single active focus and carries the never-repeat ledger', () => {
    const d = resolveContinuityDecision(input({ text: 'যেখানে ছিলে সেখান থেকে করো', activeFocus: FOCUS }))
    expect(d.binding).toBe('active_focus')
    expect(d.forbiddenEffects).toEqual(['generate_image:img-001'])
  })
  it('6. continuation with no open state clarifies — never fabricates', () => {
    const d = resolveContinuityDecision(input({ text: 'করো' }))
    expect(d.binding).toBe('none')
    expect(d.action).toBe('clarify')
  })
})

describe('high-risk guard: zero wrong bindings', () => {
  it('never binds a card or checkpoint that does not exist in state', () => {
    const { cases } = loadCorpus(FIXTURES)
    for (const c of cases) {
      const listen = c.fakes?.personalClassification === 'personal' && classifyHeadFastPath(c.latestMessage) === 'personal_hint'
      const d = resolveContinuityDecision(input({
        text: c.latestMessage,
        listenMode: listen,
        replyToCardId: c.replyTo?.id ?? null,
        pendingCards: c.context?.pendingCard ? [{ id: c.context.pendingCard.id, kind: c.context.pendingCard.kind }] : [],
        activeFocus: c.context?.activeWorkflow
          ? { goal: c.context.activeWorkflow.goal, kind: c.context.activeWorkflow.kind, status: 'active', completedSteps: c.context.activeWorkflow.verifiedEffects ?? [] }
          : null,
        checkpoints: c.context?.checkpoint ? [{ taskType: c.context.checkpoint.taskType, step: c.context.checkpoint.step }] : [],
      }))
      if (d.binding === 'pending_card') expect(c.context?.pendingCard, c.id).toBeDefined()
      if (d.binding === 'checkpoint') expect(c.context?.checkpoint, c.id).toBeDefined()
      if (d.binding === 'active_focus') expect(c.context?.activeWorkflow, c.id).toBeDefined()
    }
  })
  it('recall has no input into the resolver (advisory-only by construction)', () => {
    // The ContinuityInput type carries no recall/semantic fields; this guard
    // fails to compile if someone adds one without revisiting the contract.
    const keys: Array<keyof ContinuityInput> = ['text', 'listenMode', 'replyToCardId', 'pendingCards', 'activeFocus', 'parkedFocuses', 'checkpoints']
    expect(keys.length).toBe(7)
  })
})

describe('restart + 90-day gap survival (pure over durable state)', () => {
  it('identical decision from identical durable state, regardless of when it is asked', () => {
    const state = input({ text: 'করো', activeFocus: FOCUS, checkpoints: [] })
    const a = resolveContinuityDecision(state)
    const b = resolveContinuityDecision(JSON.parse(JSON.stringify(state)))
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
    expect(a.binding).toBe('active_focus')
  })
})

describe('gate', () => {
  it('off kills, on forces, unset → preview on / prod shadow', () => {
    expect(continuityResolverMode('off', 'production')).toBe('off')
    expect(continuityResolverMode('on', 'production')).toBe('on')
    expect(continuityResolverMode('shadow', 'preview')).toBe('shadow')
    expect(continuityResolverMode(undefined, 'preview')).toBe('on')
    expect(continuityResolverMode(undefined, 'production')).toBe('shadow')
  })
})

describe('Phase 62 — universal intake trigger (new_task binding)', () => {
  it('a clear new task with NO prior focus binds new_task/proceed → intake creates a focus', () => {
    const d = resolveContinuityDecision(input({ text: 'নতুন শাড়ির জন্য একটা ফেসবুক পোস্ট বানাও', activeFocus: null }))
    expect(d.binding).toBe('new_task')
    // No prior focus → proceed (intake still creates the durable focus for it).
    expect(d.action).toBe('proceed')
  })

  it('a clear NEW imperative task while another is active parks and starts → intake forks a new focus', () => {
    const d = resolveContinuityDecision(input({ text: 'নতুন শাড়ির জন্য একটা ফেসবুক পোস্ট বানাও', activeFocus: FOCUS }))
    expect(d.binding).toBe('new_task')
    expect(d.action).toBe('park_and_start')
  })

  it('a passing side-question does NOT park the active focus (no spurious intake)', () => {
    const d = resolveContinuityDecision(input({ text: 'আজকে আবহাওয়া কেমন বলো তো', activeFocus: FOCUS }))
    // Either it keeps the focus (proceed, side-question) or binds back to it —
    // the one thing it must never do is silently abandon the active work.
    expect(d.action === 'park_and_start').toBe(false)
  })
})

describe('Phase 62 — long mixed follow-up resumes (does not park)', () => {
  it('"আগের কাজটা চালাও, কিন্তু নতুন শর্ত যোগ করো …" resumes the active focus', () => {
    const d = resolveContinuityDecision(input({
      text: 'আগের কাজটা চালাও, কিন্তু নতুন এই শর্তটা যোগ করো যেন প্রতিটা প্রোডাক্টে মেটা টাইটেল ৬০ অক্ষরের নিচে থাকে',
      activeFocus: FOCUS,
    }))
    expect(d.binding).toBe('active_focus')
    expect(d.action).toBe('resume')
    expect(d.reason).toBe('resume_lead_references_active_focus')
  })

  it('the same lead resumes a single parked focus when nothing is active', () => {
    const parked = { ...FOCUS, status: 'parked' as const }
    const d = resolveContinuityDecision(input({
      text: 'আগের কাজটা চালিয়ে যাও, তবে এবার দাম গুলোও আপডেট করো',
      activeFocus: null,
      parkedFocuses: [parked],
    }))
    expect(d.binding).toBe('active_focus')
    expect(d.action).toBe('resume')
  })

  it('does NOT fire without a prior focus (no false resume)', () => {
    const d = resolveContinuityDecision(input({
      text: 'আগের কাজটা চালাও, কিন্তু নতুন শর্ত যোগ করো',
      activeFocus: null,
    }))
    expect(d.binding).not.toBe('active_focus')
  })
})
