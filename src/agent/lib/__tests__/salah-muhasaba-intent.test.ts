import { describe, expect, it } from 'vitest'
import { looksLikeMuhasabaReflection } from '@/agent/lib/salah-muhasaba'

describe('nightly muhasaba reply correlation', () => {
  it('rejects the production class of unrelated client SEO instruction', () => {
    expect(looksLikeMuhasabaReflection(
      'Live browser use kore 2 ta website 1 by 1 full deep SEO audit kore customer ready report file daw',
    )).toBe(false)
  })

  it('accepts a genuine salah reflection', () => {
    expect(looksLikeMuhasabaReflection('আজ ফজরটা দেরিতে পড়েছি, জামাতে হয়নি')).toBe(true)
  })

  it('rejects generic acknowledgements', () => {
    expect(looksLikeMuhasabaReflection('ok')).toBe(false)
  })
})
