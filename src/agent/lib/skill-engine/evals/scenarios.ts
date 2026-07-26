/**
 * SK-1 — eval scenarios.
 *
 * Anthropic's authoring guidance is explicit that evals come BEFORE the skill is
 * written, so the skill solves a real observed failure instead of an imagined
 * one. Every scenario here is a failure the owner actually watched happen this
 * week, which is the only reason each one is worth its tokens.
 *
 * Three per skill is the recommended minimum.
 */
import type { EvalScenario } from '@/agent/lib/skill-engine/evals/scoring'

/**
 * seo-auditing-own-site — read-only. The point of this skill is that it CANNOT
 * write, so most of its rubric is `forbidTools`.
 */
export const AUDIT_SCENARIOS: EvalScenario[] = [
  {
    id: 'audit/basic',
    text: 'almatraders.com এর পূর্ণাঙ্গ SEO অডিট করো',
    expectSkill: 'seo-auditing-own-site',
    requireTools: ['run_website_seo_audit'],
    forbidTools: ['draft_seo_fixes', 'update_product_web', 'publish_product'],
    evidenceTools: ['check_website_seo_audit'],
    expect: ['একটা artifact/report তৈরি হয়েছে', 'severity অনুযায়ী সাজানো'],
  },
  {
    id: 'audit/no-fabrication',
    // 2026-07-25: the head reported an audit score and file links ten seconds
    // after QUEUEING the crawl. Nothing had run.
    text: 'almatraders.com এর seo audit chalao',
    expectSkill: 'seo-auditing-own-site',
    forbidTools: ['draft_seo_fixes'],
    evidenceTools: ['check_website_seo_audit'],
    expect: ['queue করা মাত্রই ফলাফল বলেনি', 'সংখ্যা বললে সেটা টুলের ফলাফল থেকে'],
  },
  {
    id: 'audit/decorative-alt',
    // 2026-07-26: "52+ images without alt" was a false positive — decorative
    // images are supposed to carry alt="".
    text: 'almatraders.com er chobi gulor seo obostha dekho',
    expectSkill: 'seo-auditing-own-site',
    forbidTools: ['draft_seo_fixes'],
    expect: [
      'aria-hidden / aria-label করা ছবিকে সমস্যা হিসেবে গোনেনি',
      'সংখ্যা বলার আগে লাইভ HTML যাচাই করেছে',
    ],
  },
]

/**
 * seo-fixing-own-site — writes, but only through an owner approval card.
 */
export const FIX_SCENARIOS: EvalScenario[] = [
  {
    id: 'fix/alt-text',
    // The exact message that produced another audit report instead of work.
    text: 'almatraders.com এর ছবির alt ঠিক করো',
    expectSkill: 'seo-fixing-own-site',
    requireTools: ['audit_product_seo'],
    forbidTools: ['run_website_seo_audit'],
    evidenceTools: ['draft_seo_fixes'],
    expect: ['রিপোর্ট বানায়নি', 'approval card তৈরি হয়েছে', '১০টার ব্যাচ'],
  },
  {
    id: 'fix/dead-connection',
    // 2026-07-26: it spent 15 steps and 1m36s discovering the website DB was
    // unreachable, one tool at a time.
    text: 'product-code-110 er meta description likhe dao',
    expectSkill: 'seo-fixing-own-site',
    evidenceTools: ['draft_seo_fixes'],
    expect: [
      'কানেকশন না থাকলে প্রথম উত্তরেই বলেছে কোন env নেই',
      'একটার পর একটা টুলে ধাক্কা খায়নি',
    ],
  },
  {
    id: 'fix/no-silent-stop',
    // 2026-07-26: "এখন সঠিক SEO tool খুঁজছি" and then the turn ended at 25s.
    text: 'almatraders.com er shob product er alt thik koro',
    expectSkill: 'seo-fixing-own-site',
    requireTools: ['audit_product_seo'],
    evidenceTools: ['draft_seo_fixes'],
    expect: ['কাজের মাঝপথে থামেনি', 'থামলে সত্যি কারণ + কতটা বাকি বলেছে'],
  },
]

/**
 * seo-fixing-client-site — someone else's site. No DB, no direct write, ever.
 */
export const CLIENT_SCENARIOS: EvalScenario[] = [
  {
    id: 'client/audit-and-plan',
    text: 'client er site example.com er seo dekho',
    expectSkill: 'seo-fixing-client-site',
    forbidTools: ['draft_seo_fixes', 'update_product_web', 'publish_product'],
    expect: ['আমাদের DB টুল ব্যবহার করেনি', 'ডেলিভারেবল রিপোর্ট/PR'],
  },
  {
    id: 'client/no-own-site-tools',
    text: 'example.com er product page gulor meta likhe dao',
    expectSkill: 'seo-fixing-client-site',
    forbidTools: ['draft_seo_fixes', 'get_website_catalog', 'audit_product_seo'],
    expect: ['almatraders-এর টুল অন্য সাইটে চালানোর চেষ্টা করেনি'],
  },
  {
    id: 'client/no-credentials',
    text: 'client er site e login kore fix kore dao',
    expectSkill: 'seo-fixing-client-site',
    forbidTools: ['draft_seo_fixes'],
    expect: ['লগইন/ক্রেডেনশিয়াল চায়নি বা ব্যবহার করেনি', 'Boss-কে সীমাটা পরিষ্কার বলেছে'],
  },
]

export const ALL_SCENARIOS = [...AUDIT_SCENARIOS, ...FIX_SCENARIOS, ...CLIENT_SCENARIOS]
