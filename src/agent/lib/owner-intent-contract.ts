import { TOOL_CLASSIFICATION } from '@/agent/tools/capability-classification'

const COPY_DELIVERABLE_RE =
  /(caption|primary\s*text|content|copy|ক্যাপশন).*(likh|lekho|লিখ|write|draft|detail|বিস্তারিত)|(likh|লিখ|write|draft).*(caption|primary\s*text|content|copy|ক্যাপশন)/i

const EXTERNAL_ACTION_WORD =
  '(?:paste|পেস্ট|post|পোস্ট|publish|ads?\\s*manager(?:-?এ)?|campaign|ক্যাম্পেইন|send|পাঠা(?:ও|বেন|তে)?)'

const NEGATED_EXTERNAL_ACTION_RE = new RegExp(
  `(?:কোথাও\\s*)?${EXTERNAL_ACTION_WORD}(?:\\s*(?:বা|or|/|,)\\s*${EXTERNAL_ACTION_WORD})*[^।.!?\\n]{0,24}?(?:কোরো|করো|করবেন|করবা|করিস|দেও|দিও|দেবে)?\\s*না|` +
  `(?:do\\s+not|don't|never|without)\\s+(?:[^।.!?\\n]{0,16}\\s+)?${EXTERNAL_ACTION_WORD}`,
  'gi',
)

const COPY_ONLY_EFFECT_DOMAINS = new Set([
  'ads',
  'browser',
  'content',
  'creative',
  'gbp',
  'growth',
  'live_browser',
  'marketing',
  'social',
  'website',
])

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Remove only explicitly negated effects so "post কোরো না" is not authorization. */
export function stripNegatedExternalActions(value: string): string {
  return normalized(value).replace(NEGATED_EXTERNAL_ACTION_RE, ' ')
}

export function hasAffirmativeExternalAction(value: string): boolean {
  return new RegExp(EXTERNAL_ACTION_WORD, 'i').test(stripNegatedExternalActions(value))
}

/**
 * A copy-only request asks for text in chat and does not also authorize an
 * external effect. It needs no specialist/tool hop: the owner head can answer.
 */
export function isCopyOnlyOwnerRequest(ownerInstructions: string): boolean {
  const owner = normalized(ownerInstructions)
  return COPY_DELIVERABLE_RE.test(owner) && !hasAffirmativeExternalAction(owner)
}

export type OwnerIntentToolViolation = {
  code: 'OWNER_INTENT_MISMATCH'
  message: string
}

/**
 * Deterministic pre-execution contract. Prompt instructions are helpful but a
 * model may still broaden "write copy here" into Ads Manager/campaign work.
 * Read tools remain available for factual grounding; unknown tools fail open.
 */
export function validateToolCallAgainstOwnerIntent(input: {
  ownerInstructions: string
  toolName: string
}): OwnerIntentToolViolation | null {
  if (!isCopyOnlyOwnerRequest(input.ownerInstructions)) return null

  const classification = TOOL_CLASSIFICATION[input.toolName]
  const isDelegation = input.toolName === 'delegate_to_specialist'
  const isExternalEffect = Boolean(
    classification
    && classification.mode !== 'read'
    && COPY_ONLY_EFFECT_DOMAINS.has(classification.domain),
  )
  if (!isDelegation && !isExternalEffect) return null

  return {
    code: 'OWNER_INTENT_MISMATCH',
    message:
      `OWNER_INTENT_MISMATCH: Boss requested only ready-to-use text in this chat and did not authorize ` +
      `${input.toolName}, delegation, Ads Manager, campaign, paste, post, publish, or send. ` +
      'Do not retry with another action tool. Return the complete requested copy now in a fenced copy block.',
  }
}
