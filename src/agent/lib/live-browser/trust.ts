/**
 * P1 §5.4 — Site trust tiers for the live-browser companion (per-domain, kv-stored,
 * owner-editable, no redeploy).
 *
 *   • trusted  — owner's own / known sites: normal operation.
 *   • general  — everything unlisted: read freely, act carefully (default).
 *   • lockdown — flagged pages: READ-ONLY. Extraction/scroll/screenshot only —
 *     no clicking, typing, key-presses or option-selects. Set by the owner, or
 *     AUTOMATICALLY when the §5.5 injection tripwire fires on a page from that
 *     domain (safety-first: an auto-flag wins over an owner "trusted" mark until
 *     the owner explicitly clears it).
 *
 * Matching is by hostname suffix: an entry for "example.com" also covers
 * "shop.example.com". Enforcement happens in live_browser_act (server) AND in
 * the extension (checks the ACTIVE tab's real hostname — covers redirects the
 * server can't see).
 */
import { prisma } from '@/lib/prisma'

export const SITE_TIERS_KV_KEY = 'live_browser_site_tiers'

export type SiteTier = 'trusted' | 'general' | 'lockdown'

export type SiteTierEntry = {
  tier: Exclude<SiteTier, 'general'>
  reason: string
  /** who set it — the owner, or the injection tripwire */
  by: 'owner' | 'auto'
  at: string
}

export type SiteTierMap = Record<string, SiteTierEntry>

/** Lowercase registrable-ish hostname: strips scheme, path, port, leading www. */
export function normalizeDomain(input: string): string {
  let host = String(input ?? '').trim().toLowerCase()
  if (!host) return ''
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname
    else if (host.includes('/')) host = host.split('/')[0]
  } catch {
    /* not a URL — treat as bare host */
  }
  host = host.split(':')[0].replace(/^www\./, '').replace(/\.$/, '')
  // guard against garbage keys polluting the kv map
  if (!/^[a-z0-9.-]+$/.test(host)) return ''
  return host
}

export async function getSiteTiers(): Promise<SiteTierMap> {
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: SITE_TIERS_KV_KEY },
      select: { value: true },
    })
    const parsed = row?.value ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' ? (parsed as SiteTierMap) : {}
  } catch {
    return {}
  }
}

async function saveSiteTiers(map: SiteTierMap): Promise<void> {
  const value = JSON.stringify(map)
  await prisma.agentKvSetting.upsert({
    where: { key: SITE_TIERS_KV_KEY },
    create: { key: SITE_TIERS_KV_KEY, value },
    update: { value },
  })
}

/** Longest-suffix tier match for a URL/hostname. Unlisted → 'general'. */
export function tierForHost(map: SiteTierMap, urlOrHost: string): { tier: SiteTier; entry?: SiteTierEntry; domain?: string } {
  const host = normalizeDomain(urlOrHost)
  if (!host) return { tier: 'general' }
  const parts = host.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.')
    const entry = map[candidate]
    if (entry) return { tier: entry.tier, entry, domain: candidate }
  }
  return { tier: 'general' }
}

export async function tierForUrl(urlOrHost: string): Promise<{ tier: SiteTier; entry?: SiteTierEntry; domain?: string }> {
  return tierForHost(await getSiteTiers(), urlOrHost)
}

/**
 * Set a domain's tier. tier='general' removes the entry (general is the default).
 * Owner edits always win; the injection tripwire uses by='auto'.
 */
export async function setSiteTier(
  domain: string,
  tier: SiteTier,
  reason: string,
  by: 'owner' | 'auto' = 'owner',
): Promise<{ ok: boolean; domain?: string; error?: string }> {
  const host = normalizeDomain(domain)
  if (!host || !host.includes('.')) return { ok: false, error: `invalid domain: ${domain}` }
  const map = await getSiteTiers()
  if (tier === 'general') delete map[host]
  else map[host] = { tier, reason: String(reason ?? '').slice(0, 200), by, at: new Date().toISOString() }
  await saveSiteTiers(map)
  return { ok: true, domain: host }
}

/**
 * Injection tripwire auto-flag: force the page's domain to lockdown (safety wins
 * over an existing owner 'trusted' mark — the owner can clear it after review).
 * Best-effort by contract: the read path that calls this must never throw.
 */
export async function flagLockdownForUrl(url: string, reason: string): Promise<string | null> {
  try {
    const host = normalizeDomain(url)
    if (!host || !host.includes('.')) return null
    const res = await setSiteTier(host, 'lockdown', reason, 'auto')
    return res.ok ? host : null
  } catch {
    return null
  }
}

/** All lockdown domains — shipped with every write command for in-extension enforcement. */
export async function lockdownDomains(): Promise<string[]> {
  const map = await getSiteTiers()
  return Object.keys(map).filter((d) => map[d].tier === 'lockdown')
}
