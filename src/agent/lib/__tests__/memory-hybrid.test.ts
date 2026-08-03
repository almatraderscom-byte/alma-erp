import { describe, expect, it } from 'vitest'
import {
  BOTH_ARMS_BONUS,
  MAX_QUERY_TOKENS,
  buildLikePatterns,
  buildOrTsQuery,
  extractQueryTokens,
  fuseRrf,
  keywordSimilarityProxy,
} from '@/agent/lib/memory-hybrid'

describe('extractQueryTokens', () => {
  it('keeps Bangla content words and drops Bangla stopwords', () => {
    const tokens = extractQueryTokens('আমার অর্ডারের ডেলিভারি কবে হবে')
    expect(tokens).toContain('অর্ডারের')
    expect(tokens).toContain('ডেলিভারি')
    expect(tokens).not.toContain('আমার')
    expect(tokens).not.toContain('হবে')
  })

  it('keeps Banglish content words and drops Banglish stopwords', () => {
    const tokens = extractQueryTokens('amar order ta kobe deliver hobe boss')
    expect(tokens).toEqual(expect.arrayContaining(['order', 'deliver']))
    expect(tokens).not.toContain('amar')
    expect(tokens).not.toContain('boss')
  })

  it('keeps short tokens that contain digits — order ids and numbers matter', () => {
    const tokens = extractQueryTokens('order 42 এর কী অবস্থা')
    expect(tokens).toContain('42')
  })

  it('strips punctuation without destroying the word', () => {
    expect(extractQueryTokens('"পেমেন্ট", (bkash)!')).toEqual(['পেমেন্ট', 'bkash'])
  })

  it('deduplicates and caps the token count', () => {
    const tokens = extractQueryTokens('alpha beta alpha gamma delta epsilon zeta eta theta iota kappa')
    expect(new Set(tokens).size).toBe(tokens.length)
    expect(tokens.length).toBeLessThanOrEqual(MAX_QUERY_TOKENS)
  })

  it('returns nothing for a message made only of stopwords', () => {
    expect(extractQueryTokens('what is this')).toEqual([])
  })
})

describe('buildOrTsQuery / buildLikePatterns', () => {
  it('ORs the tokens so a long sentence still matches something', () => {
    expect(buildOrTsQuery(['অর্ডার', 'ডেলিভারি'])).toBe('অর্ডার | ডেলিভারি')
  })

  it('emits no tsquery operators from user punctuation', () => {
    // Tokens are cleaned before they get here — nothing but letters/digits survives.
    const tokens = extractQueryTokens('a&b | c:*')
    expect(buildOrTsQuery(tokens)).not.toMatch(/[&:*()!]/)
  })

  it('builds ILIKE patterns for long tokens and digit tokens only', () => {
    const patterns = buildLikePatterns(['abc', 'order', '42'])
    expect(patterns).toContain('%order%')
    expect(patterns).toContain('%42%')
    expect(patterns).not.toContain('%abc%')
  })

  it('caps the number of ILIKE patterns', () => {
    const many = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']
    expect(buildLikePatterns(many).length).toBeLessThanOrEqual(5)
  })
})

describe('fuseRrf', () => {
  it('ranks a row both arms found above rows only one arm found', () => {
    const vector = [{ id: 'a', rank: 0 }, { id: 'b', rank: 1 }]
    const keyword = [{ id: 'c', rank: 0 }, { id: 'b', rank: 1 }]
    const fused = fuseRrf([vector, keyword])
    expect(fused[0].id).toBe('b')
    expect(fused[0].arms).toBe(2)
  })

  it('keeps rows that only one arm could see', () => {
    const vector = [{ id: 'semantic-only', rank: 0 }]
    const keyword = [{ id: 'exact-token-only', rank: 0 }]
    const ids = fuseRrf([vector, keyword]).map((h) => h.id)
    expect(ids).toContain('semantic-only')
    expect(ids).toContain('exact-token-only')
  })

  it('records the best rank a row reached in any arm', () => {
    const fused = fuseRrf([[{ id: 'x', rank: 7 }], [{ id: 'x', rank: 2 }]])
    expect(fused[0].bestRank).toBe(2)
  })

  it('handles empty arms', () => {
    expect(fuseRrf([[], []])).toEqual([])
    expect(fuseRrf([[{ id: 'a', rank: 0 }], []]).map((h) => h.id)).toEqual(['a'])
  })

  it('scores strictly by rank, not by arm order', () => {
    const a = fuseRrf([[{ id: 'first', rank: 0 }], [{ id: 'second', rank: 3 }]])
    expect(a[0].id).toBe('first')
    const b = fuseRrf([[{ id: 'second', rank: 3 }], [{ id: 'first', rank: 0 }]])
    expect(b[0].id).toBe('first')
  })
})

describe('keywordSimilarityProxy', () => {
  it('gives the top keyword hit a strong-but-not-perfect similarity', () => {
    expect(keywordSimilarityProxy(0)).toBeCloseTo(0.72, 5)
  })

  it('decays with rank and never falls below the retrieval threshold', () => {
    expect(keywordSimilarityProxy(5)).toBeLessThan(keywordSimilarityProxy(0))
    expect(keywordSimilarityProxy(99)).toBeGreaterThanOrEqual(0.45)
  })

  it('keeps the both-arms bonus small enough not to override ranking', () => {
    expect(BOTH_ARMS_BONUS).toBeGreaterThan(0)
    expect(BOTH_ARMS_BONUS).toBeLessThan(0.1)
  })
})
