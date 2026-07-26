/**
 * Owner-watched defect, 2026-07-26.
 *
 * Boss: "প্রতিটা ছবির জন্য বাংলা SEO-friendly alt লেখো এবং সেভ করো।"
 * The head could not — Vercel Preview had WEBSITE_SUPABASE_SERVICE_ROLE_KEY but
 * not WEBSITE_SUPABASE_URL. It found that out over 15 steps and 1m36s, failing
 * through get_website_catalog, run_website_seo_audit and audit_product_seo one
 * at a time, and only then said so.
 *
 * A broken tool belongs in the first sentence, not the fifteenth step.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { capabilityPreflightBlock, deadCapabilities } from '@/agent/lib/capability-preflight'

const SAVED = {
  url: process.env.WEBSITE_SUPABASE_URL,
  publicUrl: process.env.NEXT_PUBLIC_WEBSITE_SUPABASE_URL,
  key: process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY,
  altKey: process.env.WEBSITE_SUPABASE_SERVICE_KEY,
}

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_WEBSITE_SUPABASE_URL
  delete process.env.WEBSITE_SUPABASE_SERVICE_KEY
})

afterEach(() => {
  restore('WEBSITE_SUPABASE_URL', SAVED.url)
  restore('NEXT_PUBLIC_WEBSITE_SUPABASE_URL', SAVED.publicUrl)
  restore('WEBSITE_SUPABASE_SERVICE_ROLE_KEY', SAVED.key)
  restore('WEBSITE_SUPABASE_SERVICE_KEY', SAVED.altKey)
})

describe('the half-configured case that actually happened', () => {
  beforeEach(() => {
    delete process.env.WEBSITE_SUPABASE_URL
    process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  })

  it('names the ONE variable that is missing, not both', () => {
    const [cap] = deadCapabilities()
    expect(cap.id).toBe('website_supabase')
    expect(cap.reason).toContain('WEBSITE_SUPABASE_URL')
    expect(cap.reason).not.toContain('SERVICE_ROLE_KEY')
  })

  it('warns the head before its first step, naming the dead tools', () => {
    const block = capabilityPreflightBlock(['draft_seo_fixes', 'get_orders', 'audit_product_seo'])
    expect(block).toContain('draft_seo_fixes')
    expect(block).toContain('audit_product_seo')
    expect(block).toContain('WEBSITE_SUPABASE_URL')
    expect(block).not.toContain('get_orders')
  })

  it('tells it not to tour the failure, and not to pre-write unsaveable content', () => {
    const block = capabilityPreflightBlock(['draft_seo_fixes'])
    expect(block).toContain('একটার পর একটা চেষ্টা করে')
    expect(block).toContain('প্রথম উত্তরেই')
    expect(block).toContain('বানিয়ে রেখো না')
  })

  it('costs nothing on a turn that never had those tools', () => {
    expect(capabilityPreflightBlock(['get_orders', 'get_sales_summary'])).toBe('')
  })

  it('reports everything when the caller has no tool list yet', () => {
    expect(capabilityPreflightBlock()).toContain('WEBSITE_SUPABASE_URL')
  })
})

describe('when the connection is healthy', () => {
  it('says nothing at all — no prompt bytes, no cache churn', () => {
    process.env.WEBSITE_SUPABASE_URL = 'https://example.supabase.co'
    process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    expect(deadCapabilities()).toEqual([])
    expect(capabilityPreflightBlock(['draft_seo_fixes'])).toBe('')
    expect(capabilityPreflightBlock()).toBe('')
  })
})
