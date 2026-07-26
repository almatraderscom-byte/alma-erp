/**
 * Browser DRIVERS — which browser actually executes an approved browser task.
 *
 * Until now there was exactly one executor: the VPS Playwright service (headless,
 * ephemeral context). A second one already existed alongside it but on a totally
 * separate path — the ALMA Companion extension in the owner's own Mac Chrome
 * (`src/agent/lib/live-browser/companion.ts`). This module makes the choice
 * explicit and, more importantly, makes it a RULE rather than a model judgement.
 *
 * Drivers:
 *   • `vps`       — headless Playwright on the VPS. Default. Ephemeral, no login.
 *   • `vps_live`  — same VPS Chromium, but with a live view the owner can watch
 *                   and take over (CDP screencast). For tasks that may hit a
 *                   login/captcha the agent cannot pass on its own.
 *   • `companion` — the owner's real, logged-in Mac Chrome via the extension.
 *
 * The safety rule this module exists to enforce:
 *
 *   Anything carrying the owner's BUSINESS identity — Meta/Facebook ads, bank and
 *   mobile-money portals, the ERP's own admin — must run ONLY in the owner's own
 *   Chrome. Never on a datacenter IP with a persisted cookie jar. A datacenter
 *   login on those sites risks a security checkpoint or an account lock on a live
 *   business asset, which is a business incident, not a technical one.
 *
 * So an owner-only host does not "prefer" the companion driver — it can never be
 * routed anywhere else, whatever the head model asked for. The decision (including
 * an override attempt) is returned in full so the caller can persist it on the
 * pending action, which is the audit trail.
 */
import { prisma } from '@/lib/prisma'
import type { BrowserTaskPayload } from '@/agent/lib/browser/actions'

export const BROWSER_DRIVERS = ['vps', 'vps_live', 'companion'] as const
export type BrowserDriver = (typeof BROWSER_DRIVERS)[number]

/** Headless VPS Chromium — cheapest, no login, no one watching. */
export const DEFAULT_BROWSER_DRIVER: BrowserDriver = 'vps'

/** Drivers executed by the VPS browser-worker (i.e. NOT the owner's Mac). */
const VPS_DRIVERS: ReadonlySet<BrowserDriver> = new Set<BrowserDriver>(['vps', 'vps_live'])

export function isVpsDriver(driver: BrowserDriver): boolean {
  return VPS_DRIVERS.has(driver)
}

/**
 * KV: extra owner-only domains, comma/newline separated. Owner-tunable without a
 * redeploy — the built-in list below is the floor, this only ever ADDS to it.
 */
export const OWNER_ONLY_DOMAINS_KEY = 'browser_owner_only_domains'

/**
 * Hosts that may only ever be driven from the owner's own Chrome.
 *
 * Deliberately conservative and deliberately NOT clever: a plain domain list beats
 * a heuristic, because the failure mode of a miss here is a locked business
 * account. When in doubt a domain belongs on this list — the cost of a false
 * positive is only that the owner's Mac has to be awake for that one task.
 */
const OWNER_ONLY_DOMAINS: ReadonlyArray<{ domain: string; why: string }> = [
  // Meta — ads, pages, business manager, messaging.
  { domain: 'facebook.com', why: 'Meta business login' },
  { domain: 'fb.com', why: 'Meta business login' },
  { domain: 'fb.me', why: 'Meta business login' },
  { domain: 'meta.com', why: 'Meta business login' },
  { domain: 'instagram.com', why: 'Meta business login' },
  { domain: 'whatsapp.com', why: 'Meta business login' },
  { domain: 'messenger.com', why: 'Meta business login' },
  // Google properties that hold money / ad spend / the business identity.
  { domain: 'ads.google.com', why: 'Google Ads spend' },
  { domain: 'admanager.google.com', why: 'Google Ads spend' },
  { domain: 'payments.google.com', why: 'Google payments' },
  { domain: 'accounts.google.com', why: 'Google account login' },
  // Bangladesh mobile money + payment gateways.
  { domain: 'bkash.com', why: 'mobile money' },
  { domain: 'nagad.com.bd', why: 'mobile money' },
  { domain: 'rocket.com.bd', why: 'mobile money' },
  { domain: 'sslcommerz.com', why: 'payment gateway' },
  { domain: 'shurjopay.com.bd', why: 'payment gateway' },
  // Banks the business touches.
  { domain: 'dutchbanglabank.com', why: 'bank' },
  { domain: 'bracbank.com', why: 'bank' },
  { domain: 'thecitybank.com', why: 'bank' },
  { domain: 'islamibankbd.com', why: 'bank' },
  { domain: 'ebl.com.bd', why: 'bank' },
  // Generic money rails.
  { domain: 'paypal.com', why: 'money rail' },
  { domain: 'stripe.com', why: 'money rail' },
  { domain: 'wise.com', why: 'money rail' },
  { domain: 'payoneer.com', why: 'money rail' },
  // Courier / logistics portals that can dispatch real shipments.
  { domain: 'pathao.com', why: 'courier account' },
  { domain: 'steadfast.com.bd', why: 'courier account' },
  { domain: 'redx.com.bd', why: 'courier account' },
  // The business's own infrastructure consoles.
  { domain: 'vercel.com', why: 'production infrastructure' },
  { domain: 'supabase.com', why: 'production database' },
  { domain: 'github.com', why: 'source code' },
  { domain: 'hostinger.com', why: 'VPS control panel' },
]

/** Host matches a domain exactly, or is a subdomain of it. Never a substring. */
function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  const d = domain.toLowerCase().replace(/\.$/, '')
  return h === d || h.endsWith(`.${d}`)
}

/** Every host this task would visit (startUrl + all goto steps), de-duplicated. */
export function hostsInBrowserTask(payload: Pick<BrowserTaskPayload, 'steps' | 'startUrl'>): string[] {
  const urls: string[] = []
  if (payload.startUrl) urls.push(payload.startUrl)
  for (const step of payload.steps ?? []) {
    if (step.action === 'goto' && step.url) urls.push(step.url)
  }
  const hosts = new Set<string>()
  for (const raw of urls) {
    try {
      const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '')
      if (host) hosts.add(host)
    } catch {
      // normalizeBrowserTask already rejects unparseable goto URLs; ignore here.
    }
  }
  return [...hosts]
}

/**
 * Reads the owner's extra owner-only domains from KV. Fails CLOSED-ish: on a read
 * error the built-in list still applies, we simply cannot add to it. That is the
 * safe direction — a KV outage must never *widen* what the VPS may touch.
 */
async function loadExtraOwnerOnlyDomains(): Promise<string[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({
      where: { key: OWNER_ONLY_DOMAINS_KEY },
      select: { value: true },
    })
    return String(row?.value ?? '')
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
  } catch {
    return []
  }
}

export interface OwnerOnlyHit {
  host: string
  /** Plain-language reason, used on the approval card. */
  why: string
}

/** Which of these hosts are owner-only, and why. */
function findOwnerOnlyHits(hosts: string[], extraDomains: string[]): OwnerOnlyHit[] {
  const hits: OwnerOnlyHit[] = []
  for (const host of hosts) {
    const builtIn = OWNER_ONLY_DOMAINS.find((d) => hostMatchesDomain(host, d.domain))
    if (builtIn) {
      hits.push({ host, why: builtIn.why })
      continue
    }
    const extra = extraDomains.find((d) => hostMatchesDomain(host, d))
    if (extra) hits.push({ host, why: 'owner-listed domain' })
  }
  return hits
}

export interface DriverDecision {
  driver: BrowserDriver
  /** Owner-facing Bangla line explaining why this driver, shown on the card. */
  reason: string
  /** Hosts that forced the companion driver (empty when nothing was owner-only). */
  ownerOnlyHosts: OwnerOnlyHit[]
  /**
   * True when the caller asked for a VPS driver but an owner-only host overrode it.
   * Persisted on the pending action so an attempt is visible after the fact.
   */
  overrodeRequest: boolean
  /** What the caller originally asked for, when it asked for anything. */
  requestedDriver?: BrowserDriver
}

export function isBrowserDriver(value: unknown): value is BrowserDriver {
  return typeof value === 'string' && (BROWSER_DRIVERS as readonly string[]).includes(value)
}

/**
 * Decide which browser runs this task.
 *
 * Order matters: the owner-only check runs BEFORE the request is honoured, so a
 * head model that asks for `vps` on facebook.com does not get it. There is no
 * argument, no flag and no prompt wording that reaches past this.
 */
export async function resolveBrowserDriver(
  payload: Pick<BrowserTaskPayload, 'steps' | 'startUrl'>,
  requested?: unknown,
): Promise<DriverDecision> {
  const requestedDriver = isBrowserDriver(requested) ? requested : undefined
  const hosts = hostsInBrowserTask(payload)
  const extras = await loadExtraOwnerOnlyDomains()
  const ownerOnlyHosts = findOwnerOnlyHits(hosts, extras)

  if (ownerOnlyHosts.length > 0) {
    const overrodeRequest = requestedDriver !== undefined && isVpsDriver(requestedDriver)
    const list = ownerOnlyHosts.map((h) => h.host).join(', ')
    return {
      driver: 'companion',
      reason: overrodeRequest
        ? `${list} — এই সাইট শুধু আপনার নিজের Chrome-এ চলবে, VPS-এ নয় (${ownerOnlyHosts[0].why})। তাই driver বদলে companion করা হয়েছে।`
        : `${list} — আপনার লগইন করা সাইট, তাই আপনার নিজের Chrome-এ চলবে (${ownerOnlyHosts[0].why})।`,
      ownerOnlyHosts,
      overrodeRequest,
      requestedDriver,
    }
  }

  const driver = requestedDriver ?? DEFAULT_BROWSER_DRIVER
  const reason =
    driver === 'companion'
      ? 'আপনার নিজের Chrome-এ চালানোর অনুরোধ করা হয়েছে।'
      : driver === 'vps_live'
        ? 'VPS ব্রাউজারে চলবে, আপনি লাইভ দেখতে ও হাত দিতে পারবেন।'
        : 'VPS ব্রাউজারে চলবে (লগইন লাগে না, কেউ দেখার দরকার নেই)।'
  return { driver, reason, ownerOnlyHosts: [], overrodeRequest: false, requestedDriver }
}

/** Short label for the approval card / logs. */
export function driverLabel(driver: BrowserDriver): string {
  switch (driver) {
    case 'companion':
      return 'আপনার Mac-এর Chrome'
    case 'vps_live':
      return 'VPS ব্রাউজার (লাইভ দেখা যাবে)'
    default:
      return 'VPS ব্রাউজার'
  }
}
