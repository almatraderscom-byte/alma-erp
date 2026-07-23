import { describe, it, expect } from 'vitest'
import {
  detectClaimViolations,
  detectExplicitInstructionViolations,
  buildVerificationReminder,
  detectLedgerViolations,
  detectProseChoiceViolation,
  verifyClaimsAgainstLedger,
  type ToolLedgerEntry,
} from '@/agent/lib/claim-verifier'

describe('detectExplicitInstructionViolations', () => {
  it('rejects an emoji after a live no-emoji instruction', () => {
    const violations = detectExplicitInstructionViolations(
      'Boss, ৩টা idea ready 😊',
      'এখন ৮টির বদলে ৩টি করো এবং emoji ব্যবহার কোরো না।',
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('instruction_mismatch')
  })

  it('allows the same answer when it contains no emoji', () => {
    expect(detectExplicitInstructionViolations(
      'Boss, ৩টা idea নিচে দিলাম।',
      'এখন ৮টির বদলে ৩টি করো এবং emoji ব্যবহার কোরো না।',
    )).toHaveLength(0)
  })

  it('does not impose no-emoji unless the owner requested it', () => {
    expect(detectExplicitInstructionViolations(
      'Boss, ৩টা idea ready 😊',
      'এখন ৮টির বদলে ৩টি করো।',
    )).toHaveLength(0)
  })

  it('rejects the exact live copy-only failure with no deliverable', () => {
    const violations = detectExplicitInstructionViolations(
      'Boss, উপরের copy block-এ লিখে দিয়েছি। এখন Ads Manager-এ paste করব, নাকি আপনার কী নির্দেশ?',
      'Family matching carousel-এর জন্য detailed primary text এখানেই লিখে দাও; কোথাও paste বা post কোরো না।',
    )
    expect(violations.map((violation) => violation.ruleId)).toContain('copy_only_missing_deliverable')
  })

  it('accepts a complete copy-only answer in a fenced copy block', () => {
    expect(detectExplicitInstructionViolations(
      'Boss, নিচে দিলাম।\n\n```copy\nএকই রঙে, একই ভালোবাসায়—পুরো পরিবারের matching মুহূর্ত।\n```',
      'Family matching carousel-এর জন্য detailed primary text এখানেই লিখে দাও; কোথাও paste বা post কোরো না।',
    )).toHaveLength(0)
  })

  it('rejects a post-work question after a complete copy-only deliverable', () => {
    const violations = detectExplicitInstructionViolations(
      '```copy\nপরিবারের matching আনন্দ, প্রতিটি ছবিতে।\n```\n\nএখন Ads Manager-এ paste করব?',
      'Family matching carousel-এর জন্য detailed primary text এখানেই লিখে দাও; কোথাও paste বা post কোরো না।',
    )
    expect(violations.map((violation) => violation.ruleId)).toContain('copy_only_post_work_question')
  })

  it('rejects the live post-work Ads Manager offer even without a question mark', () => {
    const violations = detectExplicitInstructionViolations(
      'Boss, নিচে লিখে দিলাম।\n\n```copy\nপরিবারের matching আনন্দ, প্রতিটি ছবিতে।\n```\n\nএখন চাইলে এডিট করতে পারেন — আপনার approve দিলে Ads Manager-এ paste করার জন্য তৈরি।',
      'Family matching carousel-এর জন্য detailed primary text এখানেই লিখে দাও; কোথাও paste বা post কোরো না।',
    )
    expect(violations.map((violation) => violation.ruleId)).toContain('copy_only_post_work_question')
  })

  it('rejects the live edit/tweak offer after otherwise valid copy', () => {
    const violations = detectExplicitInstructionViolations(
      'Boss, নিচে লিখে দিলাম।\n\n```copy\nপরিবারের matching আনন্দ, প্রতিটি ছবিতে।\n```\n\nএখন পড়ে দেখুন — এডিট/টুইক লাগলে জানান।',
      'Family matching carousel-এর জন্য detailed primary text এখানেই লিখে দাও; কোথাও paste বা post কোরো না।',
    )
    expect(violations.map((violation) => violation.ruleId)).toContain('copy_only_post_work_question')
  })
})

describe('buildVerificationReminder — output contracts stay text-only', () => {
  it('does not send a copy-only rewrite through the generic action/tool branch', () => {
    const reminder = buildVerificationReminder([{
      category: 'instruction_mismatch',
      ruleId: 'copy_only_missing_deliverable',
      matchedSnippet: '(ready-to-use copy block অনুপস্থিত)',
      requiredTools: [],
    }])
    expect(reminder).toContain('OUTPUT CONTRACT FAILED — TEXT-ONLY REWRITE')
    expect(reminder).toContain('কোনো tool call, ask_user, delegation, approval')
    expect(reminder).not.toContain('যদি action আসলেই দরকার')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: Original regex claim detection
// ═══════════════════════════════════════════════════════════════════════════
describe('detectClaimViolations (Layer 1 — regex)', () => {
  it('salah mark claim with no tool call → violation', () => {
    const v = detectClaimViolations(
      'আলহামদুলিল্লাহ! মাগরিব mark করে দিয়েছি।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('salah_mark')
  })

  it('salah mark claim WITH mark_salah → no violation', () => {
    const v = detectClaimViolations(
      'আলহামদুলিল্লাহ! মাগরিব mark করে দিয়েছি।',
      ['mark_salah'],
    )
    expect(v).toHaveLength(0)
  })

  it('memory save claim with no tool → violation', () => {
    const v = detectClaimViolations(
      'ঠিক আছে বস, মনে রাখলাম।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('memory_save')
  })

  it('future intent is not a violation', () => {
    const v = detectClaimViolations(
      'আমি মনে রাখবো এটা।',
      [],
    )
    expect(v).toHaveLength(0)
  })

  it('question form is not a violation', () => {
    const v = detectClaimViolations(
      'মাগরিব পড়েছেন কি?',
      [],
    )
    expect(v).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: Ledger-based general verification
// ═══════════════════════════════════════════════════════════════════════════
describe('detectLedgerViolations (Layer 2 — general)', () => {
  it('completion claim with empty ledger → violation', () => {
    const v = detectLedgerViolations(
      'ঠিক আছে, update করে দিয়েছি।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('general_write')
  })

  it('completion claim with successful write tool → no violation', () => {
    const ledger: ToolLedgerEntry[] = [
      { toolName: 'update_setting', success: true },
    ]
    const v = detectLedgerViolations(
      'ঠিক আছে, update করে দিয়েছি।',
      ledger,
    )
    expect(v).toHaveLength(0)
  })

  it('completion claim with failed write tool → violation', () => {
    const ledger: ToolLedgerEntry[] = [
      { toolName: 'update_setting', success: false, error: 'DB error' },
    ]
    const v = detectLedgerViolations(
      'ঠিক আছে, update করে দিয়েছি।',
      ledger,
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].ruleId).toContain('failed')
  })

  it('completion claim with only read tools → violation', () => {
    const ledger: ToolLedgerEntry[] = [
      { toolName: 'get_sales_summary', success: true },
    ]
    const v = detectLedgerViolations(
      'save করেছি বস, মেমোরিতে সেভ হয়ে গেছে।',
      ledger,
    )
    expect(v.length).toBeGreaterThan(0)
  })

  it('no completion claim → no violation', () => {
    const v = detectLedgerViolations(
      'আজকের sales ১৫,০০০ টাকা।',
      [],
    )
    expect(v).toHaveLength(0)
  })

  it('short text is ignored', () => {
    const v = detectLedgerViolations('ok done', [])
    expect(v).toHaveLength(0)
  })

  it('future intent is not flagged', () => {
    const v = detectLedgerViolations(
      'আমি এটা করার চেষ্টা করব, save করব পরে।',
      [],
    )
    expect(v).toHaveLength(0)
  })

  // Regression: benign read/analysis verbs must NOT trigger a verification
  // rewrite — that re-ran the whole turn for nothing and wasted tokens.
  it('benign "চেক করেছি" read reply with read tool → no violation', () => {
    const v = detectLedgerViolations(
      'চেক করেছি বস — এখন ৩টা pending order আছে, কোনোটাই এখনো confirm হয়নি।',
      [{ toolName: 'get_orders', success: true }],
    )
    expect(v).toHaveLength(0)
  })

  it('benign "যাচাই করেছি" analysis reply → no violation', () => {
    const v = detectLedgerViolations(
      'হিসাব যাচাই করেছি — গত ৭ দিনের গড় বিক্রি প্রায় ৮০ টাকা/দিন।',
      [{ toolName: 'get_sales_summary', success: true }],
    )
    expect(v).toHaveLength(0)
  })

  it('passive "পুরোনো হয়ে গেছে" state report → no violation', () => {
    const v = detectLedgerViolations(
      'অর্ডারটা প্রায় ৬ দিন পুরোনো হয়ে গেছে, এখনো confirm হয়নি।',
      [{ toolName: 'get_orders', success: true }],
    )
    expect(v).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Combined: verifyClaimsAgainstLedger
// ═══════════════════════════════════════════════════════════════════════════
describe('verifyClaimsAgainstLedger (combined)', () => {
  it('regex violation takes priority over ledger check', () => {
    const v = verifyClaimsAgainstLedger(
      'মাগরিব mark করে দিয়েছি।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('salah_mark')
  })

  it('general claim caught when no regex matches', () => {
    const v = verifyClaimsAgainstLedger(
      'ঠিক আছে বস, সব update করে দিয়েছি settings e।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('general_write')
  })

  it('honest reply with matching tools → no violations', () => {
    const v = verifyClaimsAgainstLedger(
      'আলহামদুলিল্লাহ! মাগরিব mark করে দিয়েছি।',
      [{ toolName: 'mark_salah', success: true }],
    )
    expect(v).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// detectProseChoiceViolation — HARD RULE: choice ⇒ ask_user card (owner
// live-hit 2026-07-16: Option A/B/C asked in prose, nothing to tap)
// ═══════════════════════════════════════════════════════════════════════════
describe('detectProseChoiceViolation', () => {
  it('the exact owner-reported shape → violation', () => {
    const v = detectProseChoiceViolation(
      '✅ সুপারিশ (আপনার সিদ্ধান্ত চাই)\n' +
      '· Option A: বর্তমান ক্যাম্পেইন রেখে daily budget $5 (৳৫২০)-এ বাড়ানো (৩৫০% increase)\n' +
      '· Option B: সম্পূর্ণ নতুন Sales objective + Messaging conversation ক্যাম্পেইন বানানো\n' +
      '· Option C: আরও ৩-৪ দিন hold রেখে thin data collect করা, তারপর স্কেল সিদ্ধান্ত\n' +
      'আপনি কোন পথে যেতে চান?',
    )
    expect(v).toHaveLength(1)
    expect(v[0].category).toBe('prose_choice')
    expect(v[0].requiredTools).toContain('ask_user')
  })

  it('bare decision question without options → violation', () => {
    const v = detectProseChoiceViolation('বিশ্লেষণ শেষ। এখন কোনটা করব বস?')
    expect(v).toHaveLength(1)
  })

  it('"করব কি?" ask → violation', () => {
    const v = detectProseChoiceViolation('ক্যাম্পেইনটা এখনই চালাব কি?')
    expect(v).toHaveLength(1)
  })

  it('owner round-2 escape: "পাঠাবো নাকি …চান?" either-or → violation', () => {
    const v = detectProseChoiceViolation(
      'এটা পাঠাবো নাকি আরও ফার্ম/সফট/কোনো পরিবর্তন চান?',
    )
    expect(v).toHaveLength(1)
    expect(v[0].category).toBe('prose_choice')
  })

  it('‑ো verb spelling "করবো কি?" → violation', () => {
    const v = detectProseChoiceViolation('পোস্টটা এখনই করবো কি বস?')
    expect(v).toHaveLength(1)
  })

  it('"কোনো পরিবর্তন লাগবে?" → violation', () => {
    const v = detectProseChoiceViolation('ড্রাফট রেডি। কোনো পরিবর্তন লাগবে?')
    expect(v).toHaveLength(1)
  })

  it('informational "নাকি" inside a statement (no question) → no violation', () => {
    const v = detectProseChoiceViolation(
      'কাস্টমার বলেছে সে নাকি গতকাল অর্ডার দিয়েছিল। রেকর্ডে সেটা পাওয়া গেছে।',
    )
    expect(v).toHaveLength(0)
  })

  it('informational report with numbers and no ask → no violation', () => {
    const v = detectProseChoiceViolation(
      'আজ ১২টা অর্ডার এসেছে। ডেলিভারি রেট ২৯%। রিটার্ন ২টা — দুটোই সাইজ সমস্যা।',
    )
    expect(v).toHaveLength(0)
  })

  it('scenario enumeration WITHOUT any question → no violation', () => {
    const v = detectProseChoiceViolation(
      'তিনটা পরিস্থিতি হতে পারে:\n(ক) স্টক শেষ হলে রিঅর্ডার লাগবে।\n(খ) ডিমান্ড কমলে দাম কমাতে হবে।\n(গ) সব ঠিক থাকলে কিছুই করা লাগবে না।',
    )
    expect(v).toHaveLength(0)
  })

  it('free-form clarifying question stays allowed in prose', () => {
    const v = detectProseChoiceViolation('কাস্টমারের ফোন নম্বরটা কী বস?')
    expect(v).toHaveLength(0)
  })
})

// ── Live-hit 2026-07-24: "✅ Todo-তে লিখে রাখা হয়েছে" with ZERO tool calls ──
// (Grok head, conversation 1fb470a8, turn e5b69cb1 — nothing written to
// agent_owner_todos, verifier stayed silent.)
describe('todo write-down claims (todo_written rule + lexicon extension)', () => {
  const LIVE_REPLY = '✅ Todo-তে লিখে রাখা হয়েছে'

  it('the exact live failure with an empty ledger → violation', () => {
    const v = verifyClaimsAgainstLedger(LIVE_REPLY, [])
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('todo_write')
    expect(v[0].requiredTools).toContain('add_owner_todo')
  })

  it('same claim WITH a successful add_owner_todo → no violation', () => {
    const ledger: ToolLedgerEntry[] = [{ toolName: 'add_owner_todo', success: true }]
    expect(verifyClaimsAgainstLedger(LIVE_REPLY, ledger)).toHaveLength(0)
  })

  it('same claim with a FAILED add_owner_todo → still a violation (Layer 2)', () => {
    const ledger: ToolLedgerEntry[] = [
      { toolName: 'add_owner_todo', success: false, error: 'db timeout' },
    ]
    const v = verifyClaimsAgainstLedger(LIVE_REPLY, ledger)
    expect(v.length).toBeGreaterThan(0)
  })

  it('courtesy-question tail does not let the claim escape', () => {
    const v = verifyClaimsAgainstLedger('Todo-তে লিখে রেখেছি Boss। আর কিছু লাগবে?', [])
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('todo_write')
  })

  it('"টুডু লিস্টে যোগ করে দিয়েছি" → violation with no tool', () => {
    const v = verifyClaimsAgainstLedger('টুডু লিস্টে যোগ করে দিয়েছি Boss, কাল ব্যাংকে যাওয়ার কথা।', [])
    expect(v.length).toBeGreaterThan(0)
  })

  it('future intent "Todo-তে লিখে রাখব" → no violation', () => {
    expect(verifyClaimsAgainstLedger('Boss, চাইলে Todo-তে লিখে রাখব — বলুন।', [])).toHaveLength(0)
  })

  it('generic "লিখে রেখেছি" without a todo noun, empty ledger → Layer 2 violation', () => {
    const v = detectLedgerViolations('Boss, লিখে রেখেছি — কাল ব্যাংকে যেতে হবে।', [])
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('general_write')
  })

  it('"নোট করে রাখলাম" with only read tools → Layer 2 violation', () => {
    const ledger: ToolLedgerEntry[] = [{ toolName: 'get_daily_digest', success: true }]
    const v = detectLedgerViolations('নোট করে রাখলাম Boss, কাল ব্যাংকে যেতে হবে।', ledger)
    expect(v.length).toBeGreaterThan(0)
  })
})

describe('checkmark completion claim with zero successful tools', () => {
  it('✅ + done-verb, empty ledger → checkmark_claim_no_tools violation', () => {
    const v = detectLedgerViolations('✅ ব্যাংকের কাজটা লিস্টে তোলা হয়ে গেছে Boss।', [])
    expect(v.map((x) => x.ruleId)).toContain('checkmark_claim_no_tools')
  })

  it('✅ data report AFTER a successful read tool → no violation', () => {
    const ledger: ToolLedgerEntry[] = [{ toolName: 'get_orders', success: true }]
    expect(detectLedgerViolations('✅ আজ ৩টা অর্ডার ডেলিভারি হয়ে গেছে।', ledger)).toHaveLength(0)
  })

  it('plain state report without checkmark and no lexicon verb → no violation', () => {
    expect(detectLedgerViolations('চালানটা ৬ দিন পুরোনো হয়ে গেছে, তাই দেরি হচ্ছে।', [])).toHaveLength(0)
  })
})
