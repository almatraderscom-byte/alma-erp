/**
 * A1 — "এই পণ্যের দাম ১২০০ করো" has to reach the editing skill.
 *
 * Keyword scoring cannot get there: the owner names the PRODUCT, and the only
 * word any skill could claim is "product" or nothing at all. The same shape as
 * fix-vs-audit, so it is a rule, not a score — and the rule has to stay narrow
 * enough that it never steals a new listing or an SEO copy batch.
 */
import { describe, expect, it } from 'vitest'
import path from 'path'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { applyRules, routeSkill } from '@/agent/lib/skill-engine/router'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

describe('an edit to a product already on the site', () => {
  it('routes a price change', () => {
    expect(applyRules('ei product tar dam 1200 koro')?.skill).toBe('storefront-editing')
    expect(applyRules('৭ বই কম্বোর দাম ১২০০ করে দাও')?.skill).toBe('storefront-editing')
  })

  it('routes visibility', () => {
    expect(applyRules('oi panjabi ta site theke soriye dao')?.skill).toBe('storefront-editing')
    expect(applyRules('এই পণ্যটা লাইভ করো')?.skill).toBe('storefront-editing')
  })

  it('routes homepage placement', () => {
    expect(applyRules('oita homepage e dekhao')?.skill).toBe('storefront-editing')
  })
})

describe('what it must NOT steal', () => {
  it('a new listing stays with alma-product-listing, even when a price is mentioned', () => {
    expect(applyRules('notun panjabi ta website e tolo, dam 1200')?.skill).toBe('alma-product-listing')
  })

  it('an SEO copy batch stays with the SEO skill', () => {
    expect(applyRules('almatraders.com এর ছবির alt ঠিক করো')?.skill).toBe('seo-fixing-own-site')
    expect(applyRules('product-code-110 এর meta description লিখে দাও')?.skill).toBe('seo-fixing-own-site')
  })

  it('an audit is still an audit', () => {
    expect(applyRules('almatraders.com এর পূর্ণাঙ্গ SEO অডিট করো')?.skill).toBe('seo-auditing-own-site')
  })

  it('leaves unrelated messages alone', () => {
    expect(applyRules('kalker order gulo dekhao')).toBeNull()
    expect(applyRules('ajker sale koto?')).toBeNull()
  })
})

describe('on the index production actually serves', () => {
  it('the skill is discoverable and the rule wins', async () => {
    const index = await discoverSkills(SKILLS_ROOT)
    const d = routeSkill(index, 'ei product tar dam 1200 koro')
    expect(d.skill).toBe('storefront-editing')
    expect(d.layer).toBe('rule')
  })

  it('carries the batched edit tool — a skill that cannot name its tool cannot use it', async () => {
    const index = await discoverSkills(SKILLS_ROOT)
    const skill = index.skills.find((s) => s.name === 'storefront-editing')
    expect(skill).toBeTruthy()
    expect(skill?.requiredCapabilities).toContain('edit_storefront_product')
  })
})
