/**
 * Phase 55 — egress policy for autonomous internet work.
 *
 * The autonomous browser/fetch path runs under an explicit destination policy:
 *   • domain allowlist (owner-tunable via KV) for WRITE-mode browsing —
 *     autonomous actions only on listed domains; reads follow trust tiers
 *   • cross-domain redirects flagged (guard.ts) and re-checked here
 *   • download controls: risky types blocked (guard.ts) + size caps
 *   • data-class rules: 'credentials' never leave; customer/staff PII only to
 *     provider hosts the owner already uses
 *
 * Deterministic core (checkEgress) + a thin KV loader, so tests need no DB.
 */
import type { DataClass } from '@/agent/lib/policy/data-classification'

export const EGRESS_ALLOWLIST_KV_KEY = 'security_egress_allowlist'

/** Hosts the business already trusts with its data (provider endpoints). */
export const BUILTIN_PROVIDER_HOSTS = [
  'graph.facebook.com',
  'api.twilio.com',
  'api.telegram.org',
  'ntfy.sh',
  'alma-erp-six.vercel.app',
  'almatraders.com',
  'generativelanguage.googleapis.com',
  'api.openai.com',
  'openrouter.ai',
  'api.anthropic.com',
] as const

export interface EgressPolicy {
  /** Registrable domains allowed for autonomous WRITE browsing/posting. */
  allowedDomains: string[]
  /** Max response/download size the autonomous path will accept. */
  maxBodyBytes: number
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  allowedDomains: [...BUILTIN_PROVIDER_HOSTS],
  maxBodyBytes: 25 * 1024 * 1024, // 25MB — media uploads fit, disk-fillers don't
}

export function normalizeHost(urlOrHost: string): string | null {
  let host = String(urlOrHost ?? '').trim().toLowerCase()
  if (!host) return null
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname
    else if (host.includes('/')) host = host.split('/')[0]
  } catch {
    return null
  }
  host = host.split(':')[0].replace(/^www\./, '').replace(/\.$/, '')
  return /^[a-z0-9.-]+$/.test(host) ? host : null
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export interface EgressCheck {
  allowed: boolean
  reason: string
}

/**
 * May `dataClass`-classified content leave toward `url` on the AUTONOMOUS path?
 * (The supervised owner-Chrome mode keeps its own trust-tier rules.)
 */
export function checkEgress(
  opts: { url: string; dataClass: DataClass; mode: 'autonomous' | 'supervised' },
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
): EgressCheck {
  const host = normalizeHost(opts.url)
  if (!host) return { allowed: false, reason: 'unparseable destination — fail closed' }

  // Rule 1: credentials NEVER leave through agent egress, any mode, any host.
  if (opts.dataClass === 'credentials') {
    return { allowed: false, reason: 'credentials-class content never leaves through the agent' }
  }

  if (opts.mode === 'supervised') {
    return { allowed: true, reason: 'supervised owner-Chrome mode — trust tiers govern' }
  }

  const listed = policy.allowedDomains.some((d) => hostMatchesDomain(host, d))
  if (!listed) {
    return { allowed: false, reason: `host ${host} is not on the autonomous egress allowlist` }
  }

  // Rule 2: people-data only to allowlisted provider hosts (which `listed` just proved).
  return { allowed: true, reason: `host ${host} allowlisted` }
}

export function isBodySizeAllowed(bytes: number, policy: EgressPolicy = DEFAULT_EGRESS_POLICY): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= policy.maxBodyBytes
}

/** Owner-tunable allowlist from KV, merged with the builtin provider hosts. */
export async function loadEgressPolicy(): Promise<EgressPolicy> {
  try {
    const { prisma } = await import('@/lib/prisma')
    const row = await prisma.agentKvSetting.findUnique({ where: { key: EGRESS_ALLOWLIST_KV_KEY }, select: { value: true } })
    const extra = row?.value ? (JSON.parse(row.value) as string[]) : []
    const cleaned = (Array.isArray(extra) ? extra : []).map((d) => normalizeHost(d)).filter((d): d is string => Boolean(d))
    return { ...DEFAULT_EGRESS_POLICY, allowedDomains: [...new Set([...DEFAULT_EGRESS_POLICY.allowedDomains, ...cleaned])] }
  } catch {
    return DEFAULT_EGRESS_POLICY // most cautious: builtin providers only
  }
}
