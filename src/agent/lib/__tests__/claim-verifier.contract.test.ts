import { describe, it, expect } from 'vitest'
import {
  detectClaimViolations,
  detectExplicitInstructionViolations,
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
