/**
 * Renaming a URL is the one SEO edit that can destroy value instead of adding it.
 *
 * `draft_seo_fixes` always refused slugs, and correctly: until the storefront
 * gained `product_redirects` (2026-07-27) a rename meant the old URL 404s and its
 * ranking is gone. One live product still carries a Bangla sentence as its slug
 * for exactly that reason.
 *
 * These pin the gate — the tool must reject anything that would trade one bad
 * slug for another, before it ever asks the owner to approve it.
 */
import { describe, it, expect } from 'vitest'
import { SEO_TOOLS } from '@/agent/tools/seo-tools'

const tool = SEO_TOOLS.find((t) => t.name === 'change_product_slug')!

/** The tool's own rule, restated — a slug is lowercase ASCII words + hyphens. */
const SLUG_OK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

describe('change_product_slug is registered and staged', () => {
  it('exists', () => {
    expect(tool).toBeTruthy()
  })

  it('requires the product and the new slug', () => {
    expect(tool.input_schema.required).toEqual(expect.arrayContaining(['slugOrId', 'newSlug']))
  })

  it('tells the head the old URL keeps working, so it can say so honestly', () => {
    expect(tool.description).toMatch(/old URL keeps working/i)
    expect(tool.description).toMatch(/redirect/i)
  })

  it('warns the head off cosmetic renames', () => {
    expect(tool.description).toMatch(/NEVER rename for cosmetics/i)
  })
})

describe('the slug shape gate', () => {
  it('accepts a real fix for the product that is stuck today', () => {
    expect(SLUG_OK.test('islamic-7-books-combo-package')).toBe(true)
    expect(SLUG_OK.test('smart-murda-moshari-mm01')).toBe(true)
  })

  it('rejects exactly what is broken about the live slugs', () => {
    for (const bad of [
      'ইসলামিক-৭টি-বইয়ের-কম্বো',      // Bangla — the actual problem
      'Islamic-7-Books',                  // uppercase
      'islamic 7 books',                  // spaces
      'islamic--books',                   // empty segment
      '-leading-hyphen',
      'trailing-hyphen-',
      'under_score',
      '',
    ]) {
      expect(SLUG_OK.test(bad)).toBe(false)
    }
  })
})

describe('the rejections that need no database', () => {
  it('refuses a malformed slug before staging anything', async () => {
    const res = await tool.handler({ slugOrId: 'anything', newSlug: 'Bad Slug Here' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/ছোট হাতের ইংরেজি/)
  })

  it('refuses a slug that is too short to describe anything', async () => {
    const res = await tool.handler({ slugOrId: 'anything', newSlug: 'ab' })
    expect(res.success).toBe(false)
  })
})
