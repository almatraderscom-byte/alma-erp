/**
 * Phase 52 — the deterministic action-policy core.
 *
 * ONE pure function (`decideActionPolicy`) answers, for every guarded tool
 * invocation: allow | stage | deny. It implements the hard autonomy
 * constitution + risk ladder — the same ordered rules the Phase 51 corpus was
 * authored against; src/agent/lib/__tests__/action-policy.test.ts replays all
 * 204 cases through THIS function and requires 100%.
 *
 * Decision meanings at runtime (tool-guard.ts):
 *   allow — execute now.
 *   stage — do not execute directly; the safe path is an approval card /
 *           proposal (stage-mode tools implement this themselves; write-mode
 *           tools need an approvalRef bound to the exact payload).
 *   deny  — refuse; includes "ask the owner" (the ask is a question, not an effect).
 *
 * Pure and side-effect-free: no DB, no env, no clock.
 */
import type { RiskTier } from '@/agent/lib/autonomy-task-catalog'

export type PolicyDecisionKind = 'allow' | 'stage' | 'deny'

export interface ActionPolicyRequest {
  tool: string
  mode: 'read' | 'stage' | 'write'
  risk: 'low' | 'medium' | 'high'
  domain: string
  /** Where the authority came from (constitution rule 1). */
  instructionOrigin: 'owner_direct' | 'owner_policy' | 'model_initiative' | 'external_content'
  /** Owner-turn mutation authorization (turn-authorization.ts) — owner surface only. */
  ownerTurnAuthorizesMutation: boolean
  /** Master autonomy policy state (autonomy-policy.ts). */
  policyEnabled: boolean
  /** Whole-taka money this call commits (0 = none). */
  moneyTaka: number
  moneyCapTaka: number
  reversible: boolean
  /** Agent confidence 0..1 for agent-initiated actions. */
  confidence: number
  /** True when the same effect was already performed/staged (exactly-once). */
  duplicateOfPriorEffect: boolean
  /** True when an approval exists but the payload changed since approval. */
  approvalPayloadChanged: boolean
  /** False when a required capability/token has been revoked. */
  capabilityRevoked: boolean
  /** False when the action targets an account/business outside its scope. */
  accountScopeOk: boolean
}

export interface PolicyDecision {
  decision: PolicyDecisionKind
  reasonClass:
    | 'account_scope'
    | 'capability_revoked'
    | 'untrusted_instruction'
    | 'stale_approval'
    | 'duplicate_effect'
    | 'read_ok'
    | 'owner_only'
    | 'irreversible_spend'
    | 'over_money_cap'
    | 'staged_card'
    | 'turn_read_only'
    | 'point_of_risk_approval'
    | 'owner_authorized'
    | 'autonomy_off'
    | 'low_confidence'
    | 'policy_auto_r1'
    | 'bounded_policy_propose'
  riskTier: RiskTier
  /** Owner-facing Bangla explanation. */
  reasonBn: string
}

/** Tier derivation — mirrors autonomy-task-catalog.deriveTier (kept pure/local
 * to avoid importing manifest state into the policy core). */
export function tierOf(req: Pick<ActionPolicyRequest, 'mode' | 'risk' | 'domain'>): RiskTier {
  if (req.mode === 'read') return 'R0'
  if (req.domain === 'autonomy' && req.mode === 'write' && req.risk === 'high') return 'R4'
  if (req.risk === 'high') return 'R3'
  if (req.risk === 'medium') return 'R2'
  return 'R1'
}

const CONFIDENCE_FLOOR = 0.8

export function decideActionPolicy(req: ActionPolicyRequest): PolicyDecision {
  const tier = tierOf(req)

  // 1. Scope failures fail closed — reads included for cross-account.
  if (!req.accountScopeOk) {
    return { decision: 'deny', reasonClass: 'account_scope', riskTier: tier, reasonBn: 'এই কাজটা অন্য অ্যাকাউন্ট/ব্যবসার সীমার বাইরে — নিরাপত্তার জন্য আটকে দিলাম।' }
  }
  if (req.capabilityRevoked && req.mode !== 'read') {
    return { decision: 'deny', reasonClass: 'capability_revoked', riskTier: tier, reasonBn: 'এই কাজের অনুমতি/টোকেন বাতিল হয়ে গেছে — আগে অ্যাক্সেস ঠিক করতে হবে।' }
  }

  // 2. Untrusted content never authorizes an effect (constitution rule 1).
  if (req.instructionOrigin === 'external_content' && req.mode !== 'read') {
    return { decision: 'deny', reasonClass: 'untrusted_instruction', riskTier: tier, reasonBn: 'নির্দেশটা এসেছে বাইরের কনটেন্ট (পেজ/মেসেজ/ডকুমেন্ট) থেকে — শুধু Boss-এর কথায় কাজ হয়।' }
  }

  // 3. Approval binds to the exact payload (constitution rule 4).
  if (req.approvalPayloadChanged && req.mode !== 'read') {
    return { decision: 'deny', reasonClass: 'stale_approval', riskTier: tier, reasonBn: 'অনুমোদনের পরে কাজের বিষয়বস্তু বদলে গেছে — নতুন করে অনুমোদন লাগবে।' }
  }

  // 4. Exactly-once (constitution rule 5) — duplicate effects AND duplicate cards.
  if (req.duplicateOfPriorEffect && req.mode !== 'read') {
    return { decision: 'deny', reasonClass: 'duplicate_effect', riskTier: tier, reasonBn: 'এই কাজটা আগেই একবার হয়েছে — দ্বিতীয়বার করলে ডুপ্লিকেট হবে, তাই আটকালাম।' }
  }

  // 5. Reads are R0 — auto within scoped access.
  if (req.mode === 'read') {
    return { decision: 'allow', reasonClass: 'read_ok', riskTier: 'R0', reasonBn: 'শুধু তথ্য পড়া — নিরাপদ।' }
  }

  // 6. R4 is owner-only, always.
  if (tier === 'R4') {
    return { decision: 'deny', reasonClass: 'owner_only', riskTier: 'R4', reasonBn: 'এটা মাস্টার-লেভেল সিদ্ধান্ত — শুধু Boss নিজে করবেন।' }
  }

  // 7. Money guards.
  if (req.moneyTaka > 0 && !req.reversible) {
    return { decision: 'deny', reasonClass: 'irreversible_spend', riskTier: tier, reasonBn: `৳${req.moneyTaka} খরচ হবে এবং ফেরানো যাবে না — Boss-এর সরাসরি অনুমতি ছাড়া হবে না।` }
  }
  if (req.moneyTaka > req.moneyCapTaka) {
    return { decision: 'deny', reasonClass: 'over_money_cap', riskTier: tier, reasonBn: `৳${req.moneyTaka} খরচ স্বয়ংক্রিয় সীমা ৳${req.moneyCapTaka}-এর বেশি — অনুমতি লাগবে।` }
  }

  // 8. Stage-mode tools stage their own approval card — that IS the safe path.
  if (req.mode === 'stage') {
    return { decision: 'stage', reasonClass: 'staged_card', riskTier: tier, reasonBn: 'কাজটা approval কার্ড আকারে সাজানো হবে — Boss অনুমোদন দিলে তবেই কার্যকর।' }
  }

  // 9. Direct writes on the owner's word.
  if (req.instructionOrigin === 'owner_direct') {
    if (!req.ownerTurnAuthorizesMutation) {
      return { decision: 'deny', reasonClass: 'turn_read_only', riskTier: tier, reasonBn: 'Boss-এর এই মেসেজ শুধু তথ্য চেয়েছে — কোনো পরিবর্তনের অনুমতি দেয়নি।' }
    }
    if (tier === 'R3') {
      return { decision: 'stage', reasonClass: 'point_of_risk_approval', riskTier: 'R3', reasonBn: 'বড় প্রভাবের কাজ — ঠিক কী পাঠানো/বদলানো হবে সেটা দেখিয়ে চূড়ান্ত অনুমোদন নেওয়া হবে।' }
    }
    return { decision: 'allow', reasonClass: 'owner_authorized', riskTier: tier, reasonBn: 'Boss সরাসরি বলেছেন এবং কাজটা ফেরানো যায় — করে দিচ্ছি।' }
  }

  // 10. Agent-initiated writes (owner_policy / model_initiative).
  if (!req.policyEnabled) {
    return { decision: 'deny', reasonClass: 'autonomy_off', riskTier: tier, reasonBn: 'স্বয়ংক্রিয় মোড বন্ধ — নিজে থেকে কিছু করব না, Boss-কে জিজ্ঞেস করব।' }
  }
  if (req.confidence < CONFIDENCE_FLOOR) {
    return { decision: 'stage', reasonClass: 'low_confidence', riskTier: tier, reasonBn: 'পুরোপুরি নিশ্চিত নই — প্রস্তাব দিয়ে Boss-এর সায় নেব।' }
  }
  if (tier === 'R1' && req.reversible) {
    return { decision: 'allow', reasonClass: 'policy_auto_r1', riskTier: 'R1', reasonBn: 'ছোট, ফেরানো-যোগ্য কাজ এবং Boss-এর নীতিতে অনুমোদিত — করে ফেলছি, হিসাব থাকবে।' }
  }
  if (tier === 'R2') {
    return { decision: 'stage', reasonClass: 'bounded_policy_propose', riskTier: 'R2', reasonBn: 'নীতিতে অনুমোদিত হলেও মাঝারি প্রভাব — প্রস্তাব আকারে দিলাম, সায় পেলে করব।' }
  }
  return { decision: 'stage', reasonClass: 'point_of_risk_approval', riskTier: tier, reasonBn: 'বড় প্রভাবের কাজ — চূড়ান্ত অনুমোদন ছাড়া হবে না।' }
}
