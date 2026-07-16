/**
 * Phase 44 — creative strategy: reusable creative matrix + hard compliance
 * gates + fatigue tracking.
 *
 * Gates (run BEFORE anything reaches a preview or approval card):
 * - Islamic/brand: no haram products/imagery references, owner brand rules.
 * - Honesty: no fabricated testimonials, no misleading urgency, no
 *   unsupported performance claims; numeric product claims must be grounded
 *   in supplied product facts.
 *
 * Pure functions — no IO, fully unit-testable.
 */

export interface ProductFacts {
  name: string
  priceBdt?: number
  facts: string[]
}

export interface ComplianceResult {
  ok: boolean
  violations: Array<{ rule: string; match: string; severity: 'block' | 'warn' }>
}

// \b does not work for Bangla — bound Bangla words by "no adjacent Bangla
// letter" so substrings inside longer words (মদ in আরামদায়ক) never match.
const BN = '[\\u0980-\\u09FF]'
const bnWord = (w: string) => `(?<!${BN})(?:${w})(?!${BN})`

/** Haram product/imagery references — hard block (Bangla + English). */
const HARAM_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: new RegExp(`\\b(alcohol|wine|beer|whisky|vodka|liquor)\\b|${bnWord('মদ|অ্যালকোহল')}`, 'i'), rule: 'haram:alcohol' },
  { re: new RegExp(`\\b(pork|bacon|ham)\\b|${bnWord('শূকর|শুকর')}`, 'i'), rule: 'haram:pork' },
  { re: new RegExp(`\\b(casino|gambling|betting|lottery)\\b|${bnWord('জুয়া|লটারি|বাজি')}`, 'i'), rule: 'haram:gambling' },
  { re: new RegExp(`\\b(riba)\\b|${bnWord('সুদ')}`, 'i'), rule: 'haram:riba' },
]

/** Fake scarcity / misleading urgency without a stated factual basis. */
const URGENCY_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: /শুধু\s*আজ(কে)?ই?\s*(শেষ|অফার)|last\s*chance|hurry\s*up.*(now|today)|আর\s*মাত্র\s*\d+\s*(টি|পিস)\s*বাকি/i, rule: 'urgency:unverified_scarcity' },
]

/** Fabricated-testimonial markers — a quote needs a real, named source. */
const TESTIMONIAL_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: /["“][^"”]{10,}["”]\s*[-—]\s*(একজন|a)\s*(সন্তুষ্ট|happy|satisfied)\s*(কাস্টমার|customer|client)/i, rule: 'testimonial:anonymous_fabricated' },
]

/** Unsupported performance promises. */
const CLAIM_PATTERNS: Array<{ re: RegExp; rule: string }> = [
  { re: /\b(guaranteed?|নিশ্চিত)\b.{0,24}\b(result|ফল|income|আয়|রেজাল্ট)|১০০%\s*(গ্যারান্টি|নিশ্চিত)|100%\s*guarantee/i, rule: 'claim:guaranteed_outcome' },
  { re: /\b(best|no\.?\s*1)\b.{0,16}\b(in|of)\b.{0,24}\b(bangladesh|country)\b|বাংলাদেশের\s*(সেরা|১\s*নম্বর)/i, rule: 'claim:unverifiable_superlative' },
]

/**
 * Check copy against the hard gates. `productFacts` grounds numeric claims:
 * any standalone number in the copy (price, %, count) must appear in the
 * facts/price — otherwise it is an ungrounded claim (warn, block if % claim).
 */
export function checkCreativeCompliance(copy: string, productFacts?: ProductFacts | null): ComplianceResult {
  const violations: ComplianceResult['violations'] = []
  const scan = (patterns: Array<{ re: RegExp; rule: string }>, severity: 'block' | 'warn') => {
    for (const { re, rule } of patterns) {
      const m = copy.match(re)
      if (m) violations.push({ rule, match: m[0].slice(0, 60), severity })
    }
  }
  scan(HARAM_PATTERNS, 'block')
  scan(URGENCY_PATTERNS, 'block')
  scan(TESTIMONIAL_PATTERNS, 'block')
  scan(CLAIM_PATTERNS, 'block')

  if (productFacts) {
    const grounded = new Set<string>()
    if (typeof productFacts.priceBdt === 'number') grounded.add(String(productFacts.priceBdt))
    for (const f of productFacts.facts) for (const n of f.match(/\d+(?:\.\d+)?/g) ?? []) grounded.add(n)
    // Normalize Bangla digits to Latin so ৳১২০০ is checked against facts too.
    const normalized = copy.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)))
    for (const numMatch of normalized.matchAll(/(\d+(?:\.\d+)?)\s*%|৳\s*(\d+)|(\d+)\s*(?:টাকা|tk|taka|bdt)/gi)) {
      const value = numMatch[1] ?? numMatch[2] ?? numMatch[3]
      if (value && !grounded.has(value)) {
        violations.push({
          rule: numMatch[1] ? 'claim:ungrounded_percent' : 'claim:ungrounded_price',
          match: numMatch[0].slice(0, 40),
          severity: numMatch[1] ? 'block' : 'warn',
        })
      }
    }
  }

  return { ok: violations.every((v) => v.severity !== 'block'), violations }
}

export type CreativeFormat = 'static' | 'carousel' | 'reel' | 'story' | 'messenger' | 'landing_page' | 'email' | 'sms' | 'organic_post'

export interface CreativeVariant {
  experimentId: string
  format: CreativeFormat
  angle: string
  hook: string
  copySkeleton: string
  destination: string
  compliance: ComplianceResult
}

/**
 * Build the creative matrix for an experiment: one variant per requested
 * format, all tied to the experiment id, each pre-gated. Variants that fail
 * a block-gate are returned with compliance.ok=false so the caller can fix
 * BEFORE preview — they must never ship.
 */
export function buildCreativeMatrix(opts: {
  experimentId: string
  hypothesis: { angle: string; hook: string; offer: string; proof: string; destination: string }
  formats: CreativeFormat[]
  productFacts?: ProductFacts | null
}): CreativeVariant[] {
  return opts.formats.map((format) => {
    const copySkeleton =
      `${opts.hypothesis.hook}\n\n${opts.hypothesis.offer}\n\nProof: ${opts.hypothesis.proof}` +
      (format === 'sms' || format === 'messenger' ? '' : `\n\n${opts.hypothesis.angle}`)
    return {
      experimentId: opts.experimentId,
      format,
      angle: opts.hypothesis.angle,
      hook: opts.hypothesis.hook,
      copySkeleton,
      destination: opts.hypothesis.destination,
      compliance: checkCreativeCompliance(copySkeleton, opts.productFacts),
    }
  })
}

export interface FatigueInput {
  /** Days the creative has been live. */
  ageDays: number
  frequency: number
  /** CTR now vs its first-week CTR (1 = unchanged, 0.5 = halved). */
  ctrTrendRatio: number
}

export interface FatigueAssessment {
  score: number // 0 fresh … 100 exhausted
  level: 'fresh' | 'aging' | 'fatigued'
  advice: string
}

/**
 * Creative/audience-level fatigue — campaign averages hide dying creatives.
 * Deterministic and monotonic: higher frequency, older age, and worse CTR
 * trend each increase the score.
 */
export function assessFatigue(input: FatigueInput): FatigueAssessment {
  const freqScore = Math.min(40, Math.max(0, (input.frequency - 1.5) * 16)) // >4 ≈ maxed
  const ageScore = Math.min(30, Math.max(0, (input.ageDays - 7) * 1.5)) // after a week it ages
  const ctrScore = Math.min(30, Math.max(0, (1 - input.ctrTrendRatio) * 60)) // CTR halved → 30
  const score = Math.round(Math.min(100, freqScore + ageScore + ctrScore))
  const level = score >= 60 ? 'fatigued' : score >= 30 ? 'aging' : 'fresh'
  return {
    score,
    level,
    advice:
      level === 'fatigued'
        ? 'Rotate creative now — frequency/CTR decay says the audience has seen this too often.'
        : level === 'aging'
          ? 'Prepare the next variant; watch frequency and CTR trend this week.'
          : 'Healthy — no action needed.',
  }
}
