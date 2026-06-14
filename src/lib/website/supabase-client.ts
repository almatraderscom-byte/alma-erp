import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Alma Lifestyle storefront (almatraders.com) uses its own Supabase project.
 * ERP Postgres does not contain `products` / `categories` — connect via WEBSITE_* env.
 */
let websiteAdminClient: SupabaseClient | null = null

export function websiteSupabaseConfigured(): boolean {
  return Boolean(resolveWebsiteSupabaseUrl() && resolveWebsiteServiceRoleKey())
}

function normalizeWebsiteSupabaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '')
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return trimmed
  const fromPg = trimmed.match(/@db\.([a-z0-9]+)\.supabase\.co/i)
  if (fromPg) return `https://${fromPg[1]}.supabase.co`
  return trimmed
}

function resolveWebsiteSupabaseUrl(): string {
  const url = (
    process.env.WEBSITE_SUPABASE_URL
    || process.env.NEXT_PUBLIC_WEBSITE_SUPABASE_URL
    || ''
  ).trim()
  return normalizeWebsiteSupabaseUrl(url)
}

function resolveWebsiteServiceRoleKey(): string {
  return (
    process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY
    || process.env.WEBSITE_SUPABASE_SERVICE_KEY
    || ''
  ).trim()
}

export function getWebsiteSupabaseAdmin(): SupabaseClient {
  const url = resolveWebsiteSupabaseUrl()
  const key = resolveWebsiteServiceRoleKey()
  if (!url || !key) {
    throw new Error(
      'Website Supabase is not configured. Set WEBSITE_SUPABASE_URL and WEBSITE_SUPABASE_SERVICE_ROLE_KEY.',
    )
  }
  if (!websiteAdminClient) {
    websiteAdminClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return websiteAdminClient
}
