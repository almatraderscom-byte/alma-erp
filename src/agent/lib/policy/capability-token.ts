/**
 * Phase 52 — signed action envelopes (constitution rule 9: separation).
 *
 * Planning/model output never directly performs an external effect. Every
 * guarded call is described by an ACTION ENVELOPE — actor, owner
 * instruction/focus binding, tool + version, normalized input, destination,
 * risk, policy version, expiry, idempotency key — hashed and HMAC-signed so a
 * deterministic executor (Phase 53 effect engine) can verify that what it is
 * about to execute is EXACTLY what was authorized. Any payload change
 * invalidates approval (constitution rule 4).
 *
 * No secrets in envelopes; the signing key is server-side (AGENT_INTERNAL_TOKEN).
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto'

export interface ActionEnvelope {
  /** Envelope format version — bump on breaking change. */
  v: 1
  /** Who initiated: the authenticated actor (owner id / surface id). */
  actor: string
  /** Surface the instruction arrived on. */
  surface: 'owner' | 'cs' | 'scheduler' | 'worker'
  /** Where the authority came from (constitution rule 1). */
  instructionOrigin: 'owner_direct' | 'owner_policy' | 'model_initiative' | 'external_content'
  /** Conversation/turn binding (focus binding from Roadmap 1). */
  conversationId?: string
  turnId?: string
  businessId?: string
  tool: string
  /** Stable hash of the normalized input payload. */
  inputHash: string
  /** Destination identity when the effect leaves the system (phone, page id, URL host…). */
  destination?: string
  riskTier: 'R0' | 'R1' | 'R2' | 'R3' | 'R4'
  /** Version of the policy rules the decision was made under. */
  policyVersion: string
  /** Approval card/record id when the decision required one. */
  approvalRef?: string
  /** Unix ms — envelope is invalid after this. */
  expiresAt: number
  /** Exactly-once key for the Phase 53 effect engine. */
  idempotencyKey: string
}

export const POLICY_VERSION = 'p52.1'

/** Envelope lifetime: long enough for an approval round-trip, short enough to go stale. */
export const ENVELOPE_TTL_MS = 15 * 60 * 1000

/**
 * Deterministic JSON: keys sorted at every level, so semantically-equal inputs
 * hash identically regardless of property order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

/** Stable hash of a normalized input payload. */
export function hashInput(input: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(input ?? {})).digest('hex')
}

function signingKey(): string {
  const token = process.env.AGENT_INTERNAL_TOKEN?.trim()
  if (token) return token
  // Audit P0-5: production must NEVER fall back to a development signing key —
  // an attacker knowing the fixed key could forge approval envelopes. Throwing
  // here is fail-closed by construction: the universal tool guard catches it
  // and blocks writes (reads proceed), so a missing secret degrades safely
  // instead of silently signing with a public constant.
  const env = process.env.VERCEL_ENV ?? (process.env.NODE_ENV === 'production' ? 'production' : '')
  if (env === 'production') {
    throw new Error('AGENT_INTERNAL_TOKEN missing in production — envelope signing unavailable (fail closed)')
  }
  // Tests / local dev / preview keep a fixed key so envelopes stay deterministic.
  return 'dev-envelope-key'
}

export function envelopeDigest(env: ActionEnvelope): string {
  return createHash('sha256').update(canonicalJson(env)).digest('hex')
}

export interface SignedEnvelope {
  envelope: ActionEnvelope
  signature: string
}

export function signEnvelope(envelope: ActionEnvelope): SignedEnvelope {
  const signature = createHmac('sha256', signingKey()).update(envelopeDigest(envelope)).digest('hex')
  return { envelope, signature }
}

export interface EnvelopeVerification {
  ok: boolean
  reason?: 'bad_signature' | 'expired' | 'payload_mismatch'
}

/**
 * Verify a signed envelope against the input that is ABOUT to execute.
 * Any drift between approved payload and executing payload fails closed.
 */
export function verifyEnvelope(
  signed: SignedEnvelope,
  executingInput: Record<string, unknown>,
  now: number = Date.now(),
): EnvelopeVerification {
  const expected = createHmac('sha256', signingKey()).update(envelopeDigest(signed.envelope)).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(signed.signature || '', 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  if (now > signed.envelope.expiresAt) return { ok: false, reason: 'expired' }
  if (hashInput(executingInput) !== signed.envelope.inputHash) return { ok: false, reason: 'payload_mismatch' }
  return { ok: true }
}

/**
 * Deterministic idempotency key for one intended effect: same actor + tool +
 * normalized payload + turn ⇒ same key, so retries/reconnects/model repetition
 * collapse onto one effect claim in the Phase 53 engine.
 */
export function buildIdempotencyKey(parts: {
  tool: string
  inputHash: string
  turnId?: string
  conversationId?: string
}): string {
  const scope = parts.turnId ?? parts.conversationId ?? 'global'
  return createHash('sha256').update(`${parts.tool}:${scope}:${parts.inputHash}`).digest('hex').slice(0, 32)
}

export function buildActionEnvelope(opts: {
  actor: string
  surface: ActionEnvelope['surface']
  instructionOrigin: ActionEnvelope['instructionOrigin']
  tool: string
  input: Record<string, unknown>
  riskTier: ActionEnvelope['riskTier']
  conversationId?: string
  turnId?: string
  businessId?: string
  destination?: string
  approvalRef?: string
  now?: number
}): ActionEnvelope {
  const inputHash = hashInput(opts.input)
  const now = opts.now ?? Date.now()
  return {
    v: 1,
    actor: opts.actor,
    surface: opts.surface,
    instructionOrigin: opts.instructionOrigin,
    conversationId: opts.conversationId,
    turnId: opts.turnId,
    businessId: opts.businessId,
    tool: opts.tool,
    inputHash,
    destination: opts.destination,
    riskTier: opts.riskTier,
    policyVersion: POLICY_VERSION,
    approvalRef: opts.approvalRef,
    expiresAt: now + ENVELOPE_TTL_MS,
    idempotencyKey: buildIdempotencyKey({ tool: opts.tool, inputHash, turnId: opts.turnId, conversationId: opts.conversationId }),
  }
}
