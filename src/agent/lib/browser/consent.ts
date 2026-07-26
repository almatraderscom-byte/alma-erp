/**
 * Per-conversation browser consent — the "don't ask me again for this job" grant.
 *
 * Every browser task is approval-gated, which is right for one task and wrong for
 * twelve: a single piece of SEO work is a dozen page visits, and a card per visit
 * trains the owner to approve without reading. That is worse than no gate at all.
 *
 * So the owner can grant consent ONCE per conversation, and the next tasks in that
 * same conversation run without a card — but only inside a deliberately narrow box:
 *
 *   • it expires (time), and it runs out (task count), whichever comes first;
 *   • it only ever covers the VPS drivers — never the owner's own Chrome;
 *   • a task flagged CRITICAL (money / checkout / delete / transfer) always asks,
 *     no matter what was granted;
 *   • a task touching an owner-only host always asks, because that task is already
 *     being force-routed to the owner's own Chrome;
 *   • it is scoped to one conversationId, so it cannot leak into other work.
 *
 * Consent is stored in the KV settings table rather than in memory because the app
 * is serverless — an in-memory grant would apply to whichever instance happened to
 * serve the request, which is indistinguishable from random.
 */
import { prisma } from '@/lib/prisma'
import type { BrowserTaskPayload } from '@/agent/lib/browser/actions'
import { isVpsDriver, type BrowserDriver } from '@/agent/lib/browser/drivers'

export const BROWSER_CONSENT_KV_KEY = 'browser_session_consent'
/** KV: how long a grant lasts, in minutes. */
export const BROWSER_CONSENT_TTL_KEY = 'browser_consent_ttl_minutes'
/** KV: how many tasks one grant covers. */
export const BROWSER_CONSENT_MAX_TASKS_KEY = 'browser_consent_max_tasks'

const DEFAULT_TTL_MINUTES = 60
const DEFAULT_MAX_TASKS = 15
/** Hard ceilings — a KV typo must not turn a grant into a standing permission. */
const MAX_TTL_MINUTES = 6 * 60
const MAX_TASKS_CEILING = 100

export interface ConsentEntry {
  driver: BrowserDriver
  grantedAt: string
  expiresAt: string
  /** Tasks still covered by this grant. */
  remaining: number
}

type ConsentMap = Record<string, ConsentEntry>

async function readKv(key: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value ?? null
  } catch {
    return null
  }
}

async function boundedNumber(key: string, fallback: number, ceiling: number): Promise<number> {
  const parsed = Number(await readKv(key))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), ceiling)
}

async function loadMap(): Promise<ConsentMap> {
  const raw = await readKv(BROWSER_CONSENT_KV_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as ConsentMap) : {}
  } catch {
    return {}
  }
}

/**
 * Writes the map, dropping anything already expired so the row cannot grow forever.
 *
 * A SPENT grant (remaining 0) is deliberately kept until it expires: dropping it
 * here would make the next task report "you never granted permission", when the
 * truth is "your grant ran out". The owner needs to be able to tell those apart.
 */
async function saveMap(map: ConsentMap): Promise<void> {
  const now = Date.now()
  const pruned: ConsentMap = {}
  for (const [id, entry] of Object.entries(map)) {
    if (entry && Date.parse(entry.expiresAt) > now) pruned[id] = entry
  }
  const value = JSON.stringify(pruned)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).agentKvSetting.upsert({
    where: { key: BROWSER_CONSENT_KV_KEY },
    create: { key: BROWSER_CONSENT_KV_KEY, value },
    update: { value },
  })
}

export interface GrantResult {
  ok: boolean
  entry?: ConsentEntry
  error?: string
}

/**
 * Grant consent for one conversation. Only ever granted for a VPS driver — the
 * owner's own Chrome keeps asking every time, because those are the tasks that
 * touch his real logged-in business accounts.
 */
export async function grantBrowserConsent(
  conversationId: string | null | undefined,
  driver: BrowserDriver,
): Promise<GrantResult> {
  const id = String(conversationId ?? '').trim()
  if (!id) return { ok: false, error: 'consent needs a conversation' }
  if (!isVpsDriver(driver)) {
    return { ok: false, error: 'consent is not available for the owner\'s own Chrome — those always ask' }
  }

  const ttlMinutes = await boundedNumber(BROWSER_CONSENT_TTL_KEY, DEFAULT_TTL_MINUTES, MAX_TTL_MINUTES)
  const maxTasks = await boundedNumber(BROWSER_CONSENT_MAX_TASKS_KEY, DEFAULT_MAX_TASKS, MAX_TASKS_CEILING)

  const entry: ConsentEntry = {
    driver,
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    remaining: maxTasks,
  }
  const map = await loadMap()
  map[id] = entry
  await saveMap(map)
  return { ok: true, entry }
}

export async function revokeBrowserConsent(conversationId: string | null | undefined): Promise<void> {
  const id = String(conversationId ?? '').trim()
  if (!id) return
  const map = await loadMap()
  if (!map[id]) return
  delete map[id]
  await saveMap(map)
}

export interface ConsentCheck {
  /** True when this task may skip the approval card. */
  granted: boolean
  /** Bangla line for the owner: why it ran without asking, or why it still asks. */
  reason: string
  /** Tasks left on the grant after this one (only when granted). */
  remaining?: number
}

/**
 * Decide whether THIS task may run on an existing grant, and spend one unit of it
 * when it may. Every refusal path is deliberate — see the module comment.
 *
 * Callers must pass a payload whose driver is already resolved, so the consent
 * decision sees the browser that will really run, not the one that was asked for.
 * `critical` is passed in rather than recomputed here, to keep this module free of
 * a runtime import cycle with actions.ts.
 */
export async function consumeBrowserConsent(
  payload: BrowserTaskPayload,
  critical: boolean,
): Promise<ConsentCheck> {
  const id = String(payload.conversationId ?? '').trim()
  if (!id) return { granted: false, reason: 'কথোপকথন শনাক্ত হয়নি — অনুমতি চাইতে হবে।' }

  // A money / irreversible task is exactly the one the owner must see. No grant
  // reaches past this, by design.
  if (critical) {
    return { granted: false, reason: 'এই কাজে টাকা/অপরিবর্তনীয় কিছু আছে — এটা সবসময় জিজ্ঞেস করবে।' }
  }
  if (payload.ownerOnlyHosts?.length) {
    return { granted: false, reason: 'আপনার লগইন করা সাইট — এটা সবসময় জিজ্ঞেস করবে।' }
  }
  const driver = payload.driver
  if (!driver || !isVpsDriver(driver)) {
    return { granted: false, reason: 'আপনার নিজের Chrome-এ চলবে — এটা সবসময় জিজ্ঞেস করবে।' }
  }

  const map = await loadMap()
  const entry = map[id]
  if (!entry) return { granted: false, reason: 'এই কথোপকথনে এখনো অনুমতি দেওয়া হয়নি।' }
  if (Date.parse(entry.expiresAt) <= Date.now()) {
    delete map[id]
    await saveMap(map)
    return { granted: false, reason: 'আগের অনুমতির মেয়াদ শেষ — আবার জিজ্ঞেস করছি।' }
  }
  if (entry.remaining <= 0) {
    delete map[id]
    await saveMap(map)
    return { granted: false, reason: 'আগের অনুমতিতে যতগুলো কাজ ছিল শেষ — আবার জিজ্ঞেস করছি।' }
  }
  // A grant for the plain VPS driver does not silently cover a live-view session:
  // that one puts a watchable browser on the box and deserves its own yes.
  if (entry.driver !== driver) {
    return { granted: false, reason: 'অনুমতি অন্য ব্রাউজারের জন্য ছিল — এটার জন্য আলাদা করে জিজ্ঞেস করছি।' }
  }

  entry.remaining -= 1
  map[id] = entry
  await saveMap(map)
  return {
    granted: true,
    remaining: entry.remaining,
    reason: `আপনার আগের অনুমতিতে চালালাম (আর ${entry.remaining}টি বাকি)।`,
  }
}

/** Read-only view for the owner: what is currently granted in this conversation. */
export async function getBrowserConsent(conversationId: string | null | undefined): Promise<ConsentEntry | null> {
  const id = String(conversationId ?? '').trim()
  if (!id) return null
  const entry = (await loadMap())[id]
  if (!entry) return null
  if (Date.parse(entry.expiresAt) <= Date.now() || entry.remaining <= 0) return null
  return entry
}
