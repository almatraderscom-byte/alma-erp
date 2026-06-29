import { describe, it, expect } from 'vitest'
import { parseFbPostRef } from '@/agent/lib/meta'

describe('parseFbPostRef — staff-submitted FB links', () => {
  it('parses a /share/p/ link as an opaque share (must be redirect-resolved, not failed)', () => {
    const r = parseFbPostRef('https://www.facebook.com/share/p/15abcXYZ/')
    expect(r.kind).toBe('share')
    expect(r.token).toBe('15abcXYZ')
  })

  it('parses a /share/r/ reel share as a video share', () => {
    const r = parseFbPostRef('https://www.facebook.com/share/r/9zYx8/')
    expect(r.kind).toBe('share')
    expect(r.looksVideo).toBe(true)
  })

  it('parses an fb.watch link as an opaque share', () => {
    const r = parseFbPostRef('https://fb.watch/abc123/')
    expect(r.kind).toBe('share')
    expect(r.looksVideo).toBe(true)
  })

  it('parses a bare pfbid permalink token as pfbid', () => {
    const r = parseFbPostRef('https://www.facebook.com/AlmaLifestyle/posts/pfbid0Abc123Def')
    expect(r.kind).toBe('pfbid')
    expect(r.token).toBe('pfbid0Abc123Def')
  })

  it('parses a numeric /posts/<id> link directly (strong path)', () => {
    const r = parseFbPostRef('https://www.facebook.com/1044848232034171/posts/1234567890')
    expect(r.kind).toBe('numeric')
    expect(r.id).toBe('1234567890')
  })

  it('parses a permalink.php story_fbid+id into a composite graph id', () => {
    const r = parseFbPostRef(
      'https://www.facebook.com/permalink.php?story_fbid=999&id=1044848232034171',
    )
    expect(r.kind).toBe('numeric')
    expect(r.id).toBe('1044848232034171_999')
  })

  it('parses a /reel/<id> link as a reel', () => {
    const r = parseFbPostRef('https://www.facebook.com/reel/555666777')
    expect(r.kind).toBe('reel')
    expect(r.id).toBe('555666777')
  })
})
