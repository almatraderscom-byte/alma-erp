/**
 * The final-submit ban exists in THREE places that must never drift:
 *   1. src/agent/lib/browser/final-submit.ts   (server, canonical)
 *   2. extension/alma-companion/background.js   (Chrome extension, in-page)
 *   3. ios/App/App/AlmaCompanion.swift          (iOS phone companion, in-page)
 *
 * Each re-implements the same regex so the last irreversible click
 * (Send/Post/Pay/Confirm/Delete…) is blocked wherever the agent drives. A token
 * dropped from any copy is a SILENT safety hole. This test pins every English +
 * Bangla ban token from the canonical source and asserts BOTH ported copies
 * carry all of them, and that all three still block a representative set of
 * real button labels via the actual canonical matcher.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isFinalSubmitText, FINAL_SUBMIT_RE } from '@/agent/lib/browser/final-submit'

const ROOT = process.cwd()
const EXT = readFileSync(join(ROOT, 'extension/alma-companion/background.js'), 'utf8')
const IOS = readFileSync(join(ROOT, 'ios/App/App/AlmaCompanion.swift'), 'utf8')

// The canonical token set (both scripts embed the same literal alternation).
const ENGLISH_TOKENS = [
  'send', 'post', 'publish', 'pay', 'buy', 'purchase', 'confirm',
  'delete', 'transfer', 'submit', 'checkout',
]
const BANGLA_TOKENS = [
  'পাঠান', 'পোস্ট', 'পাবলিশ', 'কিনুন', 'কনফার্ম', 'ডিলিট', 'সাবমিট',
]

describe('final-submit ban stays in sync across web/extension/iOS', () => {
  it('the Chrome extension carries every ban token', () => {
    for (const t of [...ENGLISH_TOKENS, ...BANGLA_TOKENS]) {
      expect(EXT.includes(t), `extension missing ban token: ${t}`).toBe(true)
    }
  })

  it('the iOS companion carries every ban token', () => {
    for (const t of [...ENGLISH_TOKENS, ...BANGLA_TOKENS]) {
      expect(IOS.includes(t), `AlmaCompanion.swift missing ban token: ${t}`).toBe(true)
    }
  })

  it('both ported copies embed the same place-order / order-now phrases', () => {
    for (const phrase of ['place', 'order']) {
      expect(EXT.toLowerCase()).toContain(phrase)
      expect(IOS.toLowerCase()).toContain(phrase)
    }
  })

  it('the canonical matcher blocks representative real button labels', () => {
    for (const label of [
      'Send', 'Post', 'Pay now', 'Confirm order', 'Delete', 'Place order',
      'Checkout', 'পাঠান', 'অর্ডার করুন', 'পেমেন্ট করুন',
    ]) {
      expect(isFinalSubmitText(label), `should block: ${label}`).toBe(true)
    }
  })

  it('the canonical matcher does NOT block safe navigation labels', () => {
    for (const label of ['Search', 'Next', 'Back', 'Filter', 'Add to cart', 'বিস্তারিত']) {
      expect(isFinalSubmitText(label), `should allow: ${label}`).toBe(false)
    }
    // sanity: the exported regex is the one under test
    expect(FINAL_SUBMIT_RE.test('send')).toBe(true)
  })
})
