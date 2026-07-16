/** Page intelligence — pattern classifier behaviour lock (2026-07-16). */
import { describe, it, expect } from 'vitest'
import { classifyPagePatterns } from '../page-patterns'

const el = (labels: string[]) => JSON.stringify(labels.map((l) => ({ tag: 'button', text: l })))

describe('classifyPagePatterns', () => {
  it('cookie banner: consent text + accept button', () => {
    const v = classifyPagePatterns({
      text: 'We use cookies to improve your experience. Accept all cookies?',
      elementsBlob: el(['Accept all', 'Settings']),
      url: 'https://shop.example.com',
    })
    expect(v.patterns).toContain('cookie_banner')
    expect(v.hintsBn[0]).toContain('Accept')
  })

  it('login wall: sign-in text + password field', () => {
    const v = classifyPagePatterns({
      text: 'You must be logged in to continue. Sign in to your account.',
      elementsBlob: JSON.stringify([{ tag: 'input', type: 'password', label: 'Password' }]),
      url: 'https://example.com/dashboard',
    })
    expect(v.patterns).toContain('login_wall')
  })

  it('captcha wall detected and marked blocking-first', () => {
    const v = classifyPagePatterns({
      text: 'Checking your browser… please verify you are human (Cloudflare).',
      elementsBlob: el([]),
      url: 'https://x.com',
    })
    expect(v.patterns[0]).toBe('captcha_or_botwall')
  })

  it('error page + search results + feed + checkout', () => {
    expect(classifyPagePatterns({ text: '404 — page not found', elementsBlob: '', url: 'https://a.com/x' }).patterns).toContain('error_page')
    expect(classifyPagePatterns({ text: 'Showing 20 results for spa', elementsBlob: '', url: 'https://g.com/search?q=spa' }).patterns).toContain('search_results')
    expect(classifyPagePatterns({ text: 'timeline', elementsBlob: '', url: 'https://www.facebook.com/feed' }).patterns).toContain('infinite_feed')
    expect(classifyPagePatterns({ text: 'Payment method — card number, place order', elementsBlob: '', url: 'https://shop.com/checkout' }).patterns).toContain('checkout_or_payment')
  })

  it('clean business page → no patterns, no noise', () => {
    const v = classifyPagePatterns({
      text: 'Queens Spa BD — সেবা তালিকা: ম্যাসাজ, ফেসিয়াল। যোগাযোগ: 01700000000',
      elementsBlob: el(['সেবা', 'যোগাযোগ']),
      url: 'https://queenspabd.com',
    })
    expect(v.patterns).toEqual([])
  })
})
