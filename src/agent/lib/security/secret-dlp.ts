/**
 * Phase 55 — secret/PII detection + redaction (deterministic DLP).
 *
 * Runs BEFORE model context, logs, traces, memory writes, screenshot metadata,
 * and outbound sends. Builds on the Phase 52 leak tripwires with named
 * categories, replacement redaction, and PII classes relevant to ALMA
 * (BD phone numbers, emails, card-like numbers).
 *
 * Redaction is stable and shape-preserving: '«redacted:api_key»' — logs stay
 * greppable, the model still understands "a key was here".
 */

export type SecretCategory =
  | 'api_key'
  | 'jwt'
  | 'private_key'
  | 'db_url'
  | 'aws_key'
  | 'webhook_secret'
  | 'password_assignment'
  | 'bd_phone'
  | 'email'
  | 'card_number'

interface DlpRule {
  category: SecretCategory
  /** true = secret (never leaves), false = PII (redacted for logs/model, allowed in explicit owner sends). */
  secret: boolean
  re: RegExp
}

const RULES: DlpRule[] = [
  { category: 'api_key', secret: true, re: /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g },
  { category: 'api_key', secret: true, re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { category: 'api_key', secret: true, re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/g },
  { category: 'jwt', secret: true, re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g },
  { category: 'private_key', secret: true, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { category: 'db_url', secret: true, re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']*:[^\s"'@]*@[^\s"']+/g },
  { category: 'aws_key', secret: true, re: /\bAKIA[0-9A-Z]{16}\b/g },
  { category: 'webhook_secret', secret: true, re: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { category: 'password_assignment', secret: true, re: /\b(password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{6,}/gi },
  // PII (redacted from logs/model context; owner-approved sends may carry them)
  { category: 'bd_phone', secret: false, re: /(?:\+?88)?01[3-9]\d{8}\b/g },
  { category: 'email', secret: false, re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
  { category: 'card_number', secret: false, re: /\b(?:\d[ -]?){15,16}\b/g },
]

export interface DlpFinding {
  category: SecretCategory
  secret: boolean
  count: number
}

export interface DlpResult {
  clean: boolean
  /** True when a SECRET (not just PII) was found. */
  hasSecrets: boolean
  findings: DlpFinding[]
  /** Input with every finding replaced by «redacted:category». */
  redacted: string
}

export function scanAndRedact(input: string): DlpResult {
  let text = String(input ?? '')
  const counts = new Map<string, DlpFinding>()

  for (const rule of RULES) {
    text = text.replace(rule.re, () => {
      const key = rule.category
      const f = counts.get(key) ?? { category: rule.category, secret: rule.secret, count: 0 }
      f.count += 1
      counts.set(key, f)
      return `«redacted:${rule.category}»`
    })
  }

  const findings = [...counts.values()]
  return {
    clean: findings.length === 0,
    hasSecrets: findings.some((f) => f.secret),
    findings,
    redacted: text,
  }
}

/** Payload gate for OUTBOUND sends: secrets never leave, whatever the surface. */
export function assertNoSecretEgress(payload: unknown): { ok: boolean; findings: DlpFinding[] } {
  let blob: string
  try {
    blob = typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    return { ok: false, findings: [{ category: 'api_key', secret: true, count: 1 }] }
  }
  const res = scanAndRedact(blob)
  return { ok: !res.hasSecrets, findings: res.findings.filter((f) => f.secret) }
}

/** Log/trace scrubber — secrets AND PII are redacted (constitution rule 11). */
export function scrubForLog(input: string): string {
  return scanAndRedact(input).redacted
}

/**
 * Model-context scrubber for untrusted blobs: secrets are redacted; PII is
 * kept (the agent legitimately reads customer phone numbers it serves) —
 * the difference from scrubForLog is deliberate.
 */
export function scrubSecretsOnly(input: string): string {
  let text = String(input ?? '')
  for (const rule of RULES) {
    if (!rule.secret) continue
    text = text.replace(rule.re, `«redacted:${rule.category}»`)
  }
  return text
}
