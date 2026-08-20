import { describe, expect, it } from 'vitest'
import {
  deriveOwnerTurnAuthorization,
  filterToolsForOwnerTurn,
  isToolAllowedForOwnerTurn,
  upgradeAuthorizationForDeliverable,
} from '../turn-authorization'

describe('owner turn authorization — model cannot widen owner intent', () => {
  it.each([
    'Ajker office kemon jacche?',
    'শুধু বলো (কিছু কোরো না): এখন কোন কাজ কোন ধাপে অপেক্ষায়?',
    'আজ staff দের কোন task দেওয়া হয়েছে?',
    'আমার website-এর সমস্যা কোথায়?',
    'SEO audit report-এ কী আছে?',
    'hello',
  ])('keeps information-only text read-only: %s', (text) => {
    expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(false)
  })

  it.each([
    'Eyafi কে আজ 2টা task দাও',
    'website title fix করো',
    'continue',
    'এই ছবি বানাও',
    'Fajr poreci',
    'আজ 500 টাকা খরচ করেছি',
    'মনে রাখো আমি simple design পছন্দ করি',
    // Banglish imperatives (owner-approved fix 2026-07-14 — the pair-code
    // incident: "daw" was read as information-only)
    'amk pair code daw, live browse er jnne',
    'oi task ta Mustahid ke pathao',
    'ei chobi ta abar banao',
    'campaign ta chalu koro',
    'live_browser_act-এর navigate action চালাও, তারপর live_browser_look দিয়ে proof দাও',
  ])('allows an explicit action or recordable fact: %s', (text) => {
    expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(true)
  })

  it('explicit no-action language wins even when mutation words appear', () => {
    const auth = deriveOwnerTurnAuthorization('শুধু বলো fix কীভাবে হবে, কিছু কোরো না')
    expect(auth).toEqual({ allowMutations: false, reason: 'explicit_no_action' })
    expect(deriveOwnerTurnAuthorization('kichu koro na, sudhu bolo ki obostha').allowMutations).toBe(false)
  })

  // Owner-approved policy (2026-07-14): a text-GUESSED read-only turn keeps
  // stage tools (a card is gated by the owner's Approve anyway) and the
  // owner-service tools (ask_user / memory / checkpoints / pairing). Only
  // direct writes are blocked. An EXPLICIT "কিছু কোরো না" stays strict.
  it('information-only guess blocks direct writes but keeps reads, stage and service tools', () => {
    const auth = deriveOwnerTurnAuthorization('Ajker office kemon jacche?')
    expect(auth.reason).toBe('information_only')
    const tools = [
      { name: 'get_shift_handover' },
      { name: 'prepare_staff_task_proposal' }, // stage → allowed
      { name: 'merge_into_proposal' }, // stage → allowed
      { name: 'save_memory' }, // service → allowed
      { name: 'ask_user' }, // service → allowed
      { name: 'live_browser_pair' }, // service → allowed (the incident tool)
      { name: 'update_staff_task_status' }, // direct write → blocked
      { name: 'mark_salah' }, // direct write → blocked
    ]
    expect(filterToolsForOwnerTurn(tools, auth).map((t) => t.name)).toEqual([
      'get_shift_handover',
      'prepare_staff_task_proposal',
      'merge_into_proposal',
      'save_memory',
      'ask_user',
      'live_browser_pair',
    ])
  })

  it('explicit no-action strips stage tools too, keeping reads + service', () => {
    const auth = deriveOwnerTurnAuthorization('শুধু বলো, কিছু কোরো না — আজ কী হলো?')
    expect(auth.reason).toBe('explicit_no_action')
    expect(isToolAllowedForOwnerTurn('prepare_staff_task_proposal', auth)).toBe(false)
    expect(isToolAllowedForOwnerTurn('merge_into_proposal', auth)).toBe(false)
    expect(isToolAllowedForOwnerTurn('get_staff_tasks', auth)).toBe(true)
    expect(isToolAllowedForOwnerTurn('ask_user', auth)).toBe(true)
    expect(isToolAllowedForOwnerTurn('save_memory', auth)).toBe(true)
  })

  it('keeps prospective plan metadata available during an explicit read-only audit', () => {
    const prompt =
      'REAL TRACKER TEST. READ ONLY. Before doing any work, create exactly a 4-step plan. ' +
      'Then inspect the dashboard, pending orders, pending approvals, and summarize. ' +
      'Do not write, edit, approve, or change any data.'
    const auth = deriveOwnerTurnAuthorization(prompt)

    expect(auth).toEqual({ allowMutations: false, reason: 'explicit_no_action' })
    expect(filterToolsForOwnerTurn([
      { name: 'make_plan' },
      { name: 'execute_plan' },
      { name: 'get_orders' },
      { name: 'update_order' },
    ], auth).map((tool) => tool.name)).toEqual(['make_plan', 'execute_plan', 'get_orders'])
  })

  it('workflow_continuation authorization allows everything (in-flight work)', () => {
    const auth = { allowMutations: true, reason: 'workflow_continuation' as const }
    expect(isToolAllowedForOwnerTurn('post_to_facebook', auth)).toBe(true)
    expect(filterToolsForOwnerTurn([{ name: 'mark_salah' }], auth)).toHaveLength(1)
  })
})

describe('callback phrasing = action (PA-5R live miss 2026-07-24)', () => {
  it.each([
    'আজকের সেল কত হয়েছে দেখো, আর দেখা শেষ হলে এখনই আমাকে কল করে রিপোর্টটা জানাও।',
    'stock check koro ar amake call kore janabi',
    'কাজটা শেষ হলে আমাকে ফোন করে জানিও',
    'Eyafi ke pouchale amake kol kore jana',
    'আমাকে কল দিবে কাজ শেষে',
  ])('authorizes mutations: %s', (text) => {
    expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(true)
  })
})

// Live miss 2026-07-25: the owner typed "Do a Deep SEO Audit - almatraders.com"
// in plain English. The Bangla/Banglish-only gate read it as information_only,
// so ensureClientSeoBatchWorkflow never ran, the report-delivery contract never
// armed, and the finished audit was never presented — the chat just said "done".
describe('English task orders (live miss 2026-07-25)', () => {
  it.each([
    'Do a Deep SEO Audit - almatraders.com',
    'do a full audit of almatraders.com',
    'Perform a technical SEO audit on the site',
    'Audit my website and give me the fixes',
    'Analyze last month sales',
    'Build a landing page for the eid campaign',
    'Deep SEO Audit - almatraders.com',
    'full end-to-end review of the checkout flow',
  ])('authorizes mutations: %s', (text) => {
    const auth = deriveOwnerTurnAuthorization(text)
    expect(auth.allowMutations).toBe(true)
    expect(auth.reason).toBe('explicit_action')
  })

  it.each([
    'SEO audit report-এ কী আছে?',
    'what do the numbers say today?',
    'ei deep audit ta ki kaj korbe?',
    'how do the orders look?',
  ])('leaves questions information-only: %s', (text) => {
    expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(false)
  })

  it('explicit no-action still wins over an English order', () => {
    const auth = deriveOwnerTurnAuthorization('Do a deep SEO audit — no, just tell me, do not do anything')
    expect(auth.allowMutations).toBe(false)
  })
})

describe('deliverable requirement upgrades a guessed information turn', () => {
  it('a clientSeo requirement authorizes the turn', () => {
    const guessed = { allowMutations: false, reason: 'information_only' as const }
    expect(upgradeAuthorizationForDeliverable(guessed, true)).toEqual({
      allowMutations: true,
      reason: 'explicit_action',
    })
  })

  it('leaves an explicit no-action turn read-only', () => {
    const strict = { allowMutations: false, reason: 'explicit_no_action' as const }
    expect(upgradeAuthorizationForDeliverable(strict, true)).toBe(strict)
  })

  it('is a no-op without a deliverable requirement', () => {
    const guessed = { allowMutations: false, reason: 'information_only' as const }
    expect(upgradeAuthorizationForDeliverable(guessed, false)).toBe(guessed)
  })
})

describe('banglish -aw imperative spellings (live miss 2026-07-22)', () => {
  it('"message pathaw" is an explicit action, not information-only', () => {
    const auth = deriveOwnerTurnAuthorization('Eyafi ke send_whatsapp tool diye message pathaw: "test"')
    expect(auth.allowMutations).toBe(true)
    expect(auth.reason).toBe('explicit_action')
  })

  it('other -aw variants the owner types are actions too', () => {
    for (const text of ['ekta post banaw', 'campaign chalaw', 'reminder lagaw', 'Mustahid ke sms pataw']) {
      expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(true)
    }
  })

  it('plain information asks stay information-only', () => {
    const auth = deriveOwnerTurnAuthorization('ajker sales koto?')
    expect(auth.allowMutations).toBe(false)
    expect(auth.reason).toBe('information_only')
  })
})

describe('common Banglish imperatives the owner actually types', () => {
  it('"cholao" and "dekho" are orders, not questions', () => {
    // Both were missing, so "amar mac e git status cholao" — a plain instruction
    // — was gated as information_only and had its write tools stripped.
    for (const t of [
      'amar mac e git status cholao',
      'amar mac e git status dekho',
      'test ta cholao',
      'order ta dekho',
    ]) {
      expect(deriveOwnerTurnAuthorization(t).allowMutations, t).toBe(true)
    }
  })

  it('a question is still a question', () => {
    for (const t of ['aj koto sale holo?', 'ki obostha']) {
      expect(deriveOwnerTurnAuthorization(t).allowMutations, t).toBe(false)
    }
  })
})
