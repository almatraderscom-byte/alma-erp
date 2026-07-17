/**
 * Phase 55 — secret/PII DLP tests (exit gate: zero secret exfiltration).
 */
import { describe, expect, it } from 'vitest'
import { assertNoSecretEgress, scanAndRedact, scrubForLog, scrubSecretsOnly } from '@/agent/lib/security/secret-dlp'

describe('secret detection + redaction', () => {
  it('catches and redacts API keys, JWTs, private keys, DB URLs, AWS keys', () => {
    const blob = [
      'openai: sk-abcdefghijklmnop1234567890',
      'google: AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----',
      'db: postgresql://alma:supersecret@db.internal:5432/erp',
      'aws: AKIAIOSFODNN7EXAMPLE',
      'stripe hook: whsec_abcdefghijklmnop123456',
      "password = 'hunter2secret'",
    ].join('\n')
    const res = scanAndRedact(blob)
    expect(res.clean).toBe(false)
    expect(res.hasSecrets).toBe(true)
    for (const cat of ['api_key', 'jwt', 'private_key', 'db_url', 'aws_key', 'webhook_secret', 'password_assignment']) {
      expect(res.findings.some((f) => f.category === cat), cat).toBe(true)
    }
    expect(res.redacted).not.toContain('supersecret')
    expect(res.redacted).not.toContain('hunter2secret')
    expect(res.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(res.redacted).toContain('«redacted:db_url»')
  })

  it('classifies PII separately from secrets', () => {
    const res = scanAndRedact('কাস্টমার 01712345678, email test.customer@gmail.com, কার্ড 4111 1111 1111 1111')
    expect(res.hasSecrets).toBe(false)
    expect(res.findings.some((f) => f.category === 'bd_phone')).toBe(true)
    expect(res.findings.some((f) => f.category === 'email')).toBe(true)
    expect(res.findings.some((f) => f.category === 'card_number')).toBe(true)
    expect(res.redacted).not.toContain('01712345678')
  })

  it('clean Bangla business text passes untouched (no false positives)', () => {
    const text = 'আজকের বিক্রি ৪৫,২০০ টাকা। ১২টা অর্ডার ডেলিভারি হয়েছে, ৩টা পেন্ডিং। কালকে নতুন কালেকশন আসবে।'
    const res = scanAndRedact(text)
    expect(res.clean).toBe(true)
    expect(res.redacted).toBe(text)
  })
})

describe('egress + log gates', () => {
  it('assertNoSecretEgress blocks secret-bearing payloads', () => {
    expect(assertNoSecretEgress({ message: 'এই যে key: sk-abcdefghijklmnop1234567890' }).ok).toBe(false)
    expect(assertNoSecretEgress({ message: 'দাম ৩৫০ টাকা, স্টকে আছে' }).ok).toBe(true)
    // PII alone does not block an owner-approved send…
    expect(assertNoSecretEgress({ message: 'কাস্টমারের নাম্বার 01712345678' }).ok).toBe(true)
  })

  it('scrubForLog removes secrets AND PII; scrubSecretsOnly keeps PII for model context', () => {
    const raw = 'call 01712345678 re: key sk-abcdefghijklmnop1234567890'
    const logSafe = scrubForLog(raw)
    expect(logSafe).not.toContain('01712345678')
    expect(logSafe).not.toContain('sk-abcdef')
    const modelSafe = scrubSecretsOnly(raw)
    expect(modelSafe).toContain('01712345678') // the agent legitimately serves this customer
    expect(modelSafe).not.toContain('sk-abcdef')
  })

  it('unserializable payloads fail closed', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(assertNoSecretEgress(circular).ok).toBe(false)
  })
})
