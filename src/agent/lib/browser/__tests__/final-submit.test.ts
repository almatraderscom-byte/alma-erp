import { describe, it, expect } from 'vitest'
import { isFinalSubmitText } from '../final-submit'

/**
 * Feature 8 — the final-submit click ban. False negatives let the agent press
 * a real Send/Pay button; false positives block harmless navigation. Both
 * directions are pinned here. The extension mirrors this regex in
 * background.js pageClick — keep them in sync.
 */
describe('isFinalSubmitText', () => {
  it('blocks English final-submit labels', () => {
    for (const label of [
      'Send', 'Post', 'Publish', 'Pay now', 'Buy', 'Purchase', 'Confirm order',
      'Delete', 'Transfer', 'Submit', 'Checkout', 'Place order', 'Order now',
    ]) {
      expect(isFinalSubmitText(label), label).toBe(true)
    }
  })

  it('blocks Bangla final-submit labels', () => {
    for (const label of ['পাঠান', 'পোস্ট করুন', 'পাবলিশ', 'কিনুন', 'অর্ডার করুন', 'নিশ্চিত করুন', 'কনফার্ম', 'ডিলিট', 'মুছে ফেলুন', 'সাবমিট', 'পেমেন্ট করুন']) {
      expect(isFinalSubmitText(label), label).toBe(true)
    }
  })

  it('does NOT block harmless navigation/labels', () => {
    for (const label of [
      'Next', 'Search', 'Login', 'Add to cart', 'View details', 'পরবর্তী', 'খুঁজুন',
      'Compose', 'New message', 'Settings', 'Postpone reminder', // "Post" inside a word must not match
      'Sender name', // "Send" inside a word must not match
    ]) {
      expect(isFinalSubmitText(label), label).toBe(false)
    }
  })

  it('checks selector strings too and handles empty input', () => {
    expect(isFinalSubmitText('', 'button[type=submit].pay')).toBe(true)
    expect(isFinalSubmitText('', '')).toBe(false)
    expect(isFinalSubmitText(null, undefined)).toBe(false)
  })
})
