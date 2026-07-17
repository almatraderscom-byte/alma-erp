/**
 * Phase 52 exit gate: the REAL policy core must give every one of the 204
 * Phase 51 autonomy cases its expected allow/stage/deny decision — 100%,
 * against the same corpus whose baseline was 46.1%.
 */
import { describe, expect, it } from 'vitest'
import { decideActionPolicy, tierOf, type ActionPolicyRequest } from '@/agent/lib/policy/action-policy'
import { loadAutonomyFixtures, type AutonomyCase } from '@/agent/replay/run-autonomy-replay'
import { getCapability } from '@/agent/tools/capability-manifest'
import { deriveTier } from '@/agent/lib/autonomy-task-catalog'
import {
  buildActionEnvelope,
  buildIdempotencyKey,
  canonicalJson,
  hashInput,
  signEnvelope,
  verifyEnvelope,
} from '@/agent/lib/policy/capability-token'
import { dataClassFor, scanForSecretLeaks } from '@/agent/lib/policy/data-classification'
import { CAPABILITIES } from '@/agent/tools/capability-manifest'

function requestFromCase(c: AutonomyCase): ActionPolicyRequest {
  const cap = getCapability(c.tool)!
  return {
    tool: c.tool,
    mode: c.toolMode,
    risk: c.toolRisk,
    domain: cap.domain,
    instructionOrigin: c.context.instructionOrigin,
    ownerTurnAuthorizesMutation: c.context.ownerTurnAuthorizesMutation,
    policyEnabled: c.context.policyEnabled,
    moneyTaka: c.context.moneyTaka,
    moneyCapTaka: c.context.moneyCapTaka,
    reversible: c.context.reversible,
    confidence: c.context.confidence,
    duplicateOfPriorEffect: c.context.duplicateOfPriorEffect,
    approvalPayloadChanged: c.context.approvalPayloadChanged,
    capabilityRevoked: c.context.providerState === 'permission_revoked',
    accountScopeOk: c.context.accountScopeOk,
  }
}

describe('decideActionPolicy vs the 204-case corpus (Phase 52 exit gate)', () => {
  const { cases, errors } = loadAutonomyFixtures()

  it('corpus loads clean', () => {
    expect(errors).toEqual([])
    expect(cases.length).toBeGreaterThanOrEqual(200)
  })

  it('100% of cases receive their expected decision', () => {
    const failures: string[] = []
    for (const c of cases) {
      const got = decideActionPolicy(requestFromCase(c))
      if (got.decision !== c.expected.decision) {
        failures.push(`${c.id}: expected ${c.expected.decision}(${c.expected.reasonClass}) got ${got.decision}(${got.reasonClass})`)
      }
    }
    expect(failures, failures.slice(0, 10).join('\n')).toEqual([])
  })

  it('reason classes agree with the authored ground truth', () => {
    let agreed = 0
    for (const c of cases) {
      const got = decideActionPolicy(requestFromCase(c))
      if (got.reasonClass === c.expected.reasonClass) agreed += 1
    }
    expect(agreed).toBe(cases.length)
  })

  it('tierOf agrees with the catalog deriveTier for every executable tool', () => {
    for (const cap of CAPABILITIES) {
      expect(tierOf({ mode: cap.mode, risk: cap.risk, domain: cap.domain })).toBe(deriveTier(cap))
    }
  })
})

describe('constitutional invariants (property checks)', () => {
  const base: ActionPolicyRequest = {
    tool: 'x',
    mode: 'write',
    risk: 'low',
    domain: 'todo',
    instructionOrigin: 'owner_direct',
    ownerTurnAuthorizesMutation: true,
    policyEnabled: true,
    moneyTaka: 0,
    moneyCapTaka: 0,
    reversible: true,
    confidence: 1,
    duplicateOfPriorEffect: false,
    approvalPayloadChanged: false,
    capabilityRevoked: false,
    accountScopeOk: true,
  }

  it('external content NEVER yields allow for any effect, whatever else is true', () => {
    for (const mode of ['stage', 'write'] as const) {
      for (const risk of ['low', 'medium', 'high'] as const) {
        const d = decideActionPolicy({ ...base, mode, risk, instructionOrigin: 'external_content' })
        expect(d.decision).toBe('deny')
        expect(d.reasonClass).toBe('untrusted_instruction')
      }
    }
  })

  it('stale approval always denies effects', () => {
    const d = decideActionPolicy({ ...base, approvalPayloadChanged: true })
    expect(d.decision).toBe('deny')
    expect(d.reasonClass).toBe('stale_approval')
  })

  it('R4 denies even for the owner surface (owner acts via UI, not the model)', () => {
    const d = decideActionPolicy({ ...base, domain: 'autonomy', risk: 'high', reversible: false })
    expect(d.decision).toBe('deny')
    expect(d.reasonClass).toBe('owner_only')
  })

  it('irreversible spend and over-cap spend deny regardless of category mode', () => {
    expect(decideActionPolicy({ ...base, instructionOrigin: 'owner_policy', moneyTaka: 500, reversible: false }).reasonClass).toBe('irreversible_spend')
    expect(decideActionPolicy({ ...base, instructionOrigin: 'owner_policy', moneyTaka: 500, moneyCapTaka: 100 }).reasonClass).toBe('over_money_cap')
  })

  it('agent initiative with policy off always asks', () => {
    const d = decideActionPolicy({ ...base, instructionOrigin: 'model_initiative', policyEnabled: false })
    expect(d.decision).toBe('deny')
    expect(d.reasonClass).toBe('autonomy_off')
  })

  it('reads stay allowed under provider noise but deny out-of-scope', () => {
    expect(decideActionPolicy({ ...base, mode: 'read' }).decision).toBe('allow')
    expect(decideActionPolicy({ ...base, mode: 'read', accountScopeOk: false }).decision).toBe('deny')
  })
})

describe('action envelopes (constitution rules 4/5/9)', () => {
  const input = { message: 'hello', to: 'staff-1' }

  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(canonicalJson({ b: { d: [1, 2], c: 2 }, a: 1 }))
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }))
  })

  it('verifies an untouched envelope and rejects payload drift', () => {
    const env = buildActionEnvelope({
      actor: 'owner',
      surface: 'owner',
      instructionOrigin: 'owner_direct',
      tool: 'send_whatsapp',
      input,
      riskTier: 'R3',
      turnId: 't1',
    })
    const signed = signEnvelope(env)
    expect(verifyEnvelope(signed, input).ok).toBe(true)
    const drift = verifyEnvelope(signed, { ...input, message: 'hello!!' })
    expect(drift.ok).toBe(false)
    expect(drift.reason).toBe('payload_mismatch')
  })

  it('rejects tampered signatures and expired envelopes', () => {
    const env = buildActionEnvelope({
      actor: 'owner',
      surface: 'owner',
      instructionOrigin: 'owner_direct',
      tool: 'send_whatsapp',
      input,
      riskTier: 'R3',
      now: 1_000_000,
    })
    const signed = signEnvelope(env)
    expect(verifyEnvelope({ ...signed, signature: signed.signature.replace(/^./, '0') }, input, 1_000_001).ok).toBe(false)
    const expired = verifyEnvelope(signed, input, env.expiresAt + 1)
    expect(expired.ok).toBe(false)
    expect(expired.reason).toBe('expired')
  })

  it('idempotency keys collapse retries within a turn and separate across turns', () => {
    const h = hashInput(input)
    expect(buildIdempotencyKey({ tool: 't', inputHash: h, turnId: 'turn1' })).toBe(buildIdempotencyKey({ tool: 't', inputHash: h, turnId: 'turn1' }))
    expect(buildIdempotencyKey({ tool: 't', inputHash: h, turnId: 'turn1' })).not.toBe(buildIdempotencyKey({ tool: 't', inputHash: h, turnId: 'turn2' }))
  })
})

describe('data classification', () => {
  it('every executable tool resolves to a data class', () => {
    for (const cap of CAPABILITIES) {
      expect(dataClassFor(cap.name, cap.domain)).toBeTruthy()
    }
  })

  it('secret scanner catches key-shaped leaks and passes clean text', () => {
    expect(scanForSecretLeaks({ text: 'দাম ৩৫০ টাকা, কালকে পাঠাবো' }).clean).toBe(true)
    expect(scanForSecretLeaks({ note: 'key: sk-abcdefghij1234567890XYZ' }).clean).toBe(false)
    expect(scanForSecretLeaks('postgresql://user:pass@db.example.internal:5432/x').clean).toBe(false)
    expect(scanForSecretLeaks('-----BEGIN RSA PRIVATE KEY-----').clean).toBe(false)
  })
})
