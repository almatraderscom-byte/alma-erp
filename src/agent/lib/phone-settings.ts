/**
 * Phone console — the WRITE side. Step 2.
 *
 * Step 1 wrote nothing anywhere; this module is the one place that does. Everything the
 * console can change goes through `writeSetting()`, which validates against the registry,
 * refuses anything not in it, records the previous value, and can hand it back.
 *
 * Four rules from the roadmap's §3 shaped this file, and each of them prevents a failure
 * this system has actually had:
 *
 * 1. ONE WRITER. Screens never write config to the VPS. App-scoped values are read by the
 *    inbound route while a call is being set up; gateway-scoped values are PULLED by the
 *    gateway from `/api/assistant/internal/phone-config`. Nothing here opens an SSH session
 *    or edits a `.conf`, so no screen can leave Asterisk in a state nobody verified.
 * 2. SECRETS STAY PUT. No password is stored in this table, and none is ever returned. The
 *    provider credential lives encrypted in its own table (`phone-provider.ts`).
 * 3. KV, NOT ENV. Every value falls back to the env var that used to control it, so an empty
 *    settings table behaves exactly like today's system — the migration is the absence of a
 *    change, which is the only kind that cannot break a live line.
 * 4. AUDITED AND REVERSIBLE. Every write lands in `agent_audit_logs` with the previous value
 *    and who did it, and the history screen can put it back. A phone system that silently
 *    changed under you is how a whole day disappears.
 *
 * SERVER ONLY — it reaches Prisma. Client components import `phone-settings-types`.
 */
import { prisma } from '@/lib/prisma'
import {
  PHONE_SETTINGS,
  findSetting,
  type HistoryRow,
  type SettingDef,
  type SettingView,
} from '@/agent/lib/phone-settings-types'

export * from '@/agent/lib/phone-settings-types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** The audit `actionType` every phone-console setting change is filed under. */
export const PHONE_SETTING_AUDIT = 'phone_setting_change'

// ── reading ──────────────────────────────────────────────────────────────────

type Row = { key: string; value: string; updatedAt: Date }

async function kvRows(keys: string[]): Promise<Map<string, Row>> {
  try {
    const rows = (await db.agentKvSetting.findMany({ where: { key: { in: keys } } })) as Row[]
    return new Map(rows.map((r) => [r.key, r]))
  } catch {
    // A settings screen that goes blank because the database blinked is worse than one that
    // shows the env values — those are what the call path would use anyway.
    return new Map()
  }
}

function resolveOne(def: SettingDef, row: Row | undefined): SettingView {
  const kv = typeof row?.value === 'string' ? row.value.trim() : ''
  if (kv) return { key: def.key, value: kv, source: 'kv', updatedAt: row!.updatedAt.toISOString() }

  const env = (def.envName ? process.env[def.envName] : '')?.trim() ?? ''
  if (env) return { key: def.key, value: env, source: 'env', updatedAt: null }

  return { key: def.key, value: def.fallback, source: 'default', updatedAt: null }
}

/** Every setting with its effective value and where that value came from. */
export async function readSettings(): Promise<SettingView[]> {
  const rows = await kvRows(PHONE_SETTINGS.map((s) => s.key))
  return PHONE_SETTINGS.map((def) => resolveOne(def, rows.get(def.key)))
}

/**
 * One effective value, for the call path. Deliberately never throws: an inbound call must
 * not fail because a settings lookup did, so every caller gets the env/code default instead.
 */
export async function readSetting(key: string): Promise<string> {
  const def = findSetting(key)
  if (!def) return ''
  const rows = await kvRows([key]).catch(() => new Map<string, Row>())
  return resolveOne(def, rows.get(key)).value
}

/** Several at once — one query instead of one per key on the inbound hot path. */
export async function readSettingMap(keys: string[]): Promise<Record<string, string>> {
  const defs = keys.map(findSetting).filter((d): d is SettingDef => Boolean(d))
  const rows = await kvRows(defs.map((d) => d.key)).catch(() => new Map<string, Row>())
  const out: Record<string, string> = {}
  for (const def of defs) out[def.key] = resolveOne(def, rows.get(def.key)).value
  return out
}

// ── validation ───────────────────────────────────────────────────────────────

/** Last 9 digits — the same comparison the inbound route and the gateway both use. */
function tail9(n: string): string {
  return n.replace(/\D/g, '').slice(-9)
}

function ownerTails(): string[] {
  return (process.env.OWNER_PHONE_NUMBERS ?? '')
    .split(',')
    .map(tail9)
    .filter(Boolean)
}

/**
 * Returns a Bangla error, or null when the value is acceptable. The messages are written for
 * the owner, not for a log: each says what is wrong AND what a right answer looks like.
 */
export function validateSetting(def: SettingDef, raw: string): string | null {
  const value = raw.trim()

  if (def.kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n) || !/^\d+$/.test(value)) return 'শুধু সংখ্যা লিখুন।'
    if (def.min != null && n < def.min) return `সর্বনিম্ন ${def.min}।`
    if (def.max != null && n > def.max) return `সর্বোচ্চ ${def.max}।`
    return null
  }

  if (def.kind === 'enum') {
    const ok = (def.options ?? []).some((o) => o.value === value)
    return ok ? null : 'তালিকার একটা বেছে নিন।'
  }

  if (def.kind === 'hours') {
    if (!/^\d{1,2}-\d{1,2}$/.test(value)) return 'ফরম্যাট: 10-21 (শুরু-শেষ, ২৪ ঘণ্টার ঘড়ি)।'
    const [from, to] = value.split('-').map(Number)
    if (from > 23 || to > 23) return 'ঘণ্টা ০ থেকে ২৩-এর মধ্যে হতে হবে।'
    if (from === to) return 'শুরু আর শেষ এক হলে অফিস কখনো খোলে না — অন্য সময় দিন।'
    return null
  }

  if (def.kind === 'dates') {
    if (!value) return null
    for (const d of value.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return `“${d}” তারিখটা YYYY-MM-DD ফরম্যাটে নয়।`
      if (Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return `“${d}” সত্যিকারের তারিখ নয়।`
    }
    return null
  }

  if (def.kind === 'phones') {
    if (!value) return null
    const parts = value.split(',').map((x) => x.trim()).filter(Boolean)
    for (const p of parts) {
      const digits = p.replace(/\D/g, '')
      // Internal extensions are 1XXX (staff softphones); everything else must be a real BD
      // number. A 10-digit "mobile" matches nothing anyone can dial — that pattern is eleven.
      if (/^1\d{3}$/.test(digits)) continue
      if (digits.length < 10 || digits.length > 13) return `“${p}” নম্বরটা ঠিক মনে হচ্ছে না — 01XXXXXXXXX বা +880… দিন।`
    }
    // Blocking your own number would mean your own calls stop being answered. The inbound
    // route already lets the owner through, but a list you cannot trust is worse than no
    // list, so it is refused at the point of writing too.
    if (def.key === 'blocked_callers') {
      const owners = ownerTails()
      const clash = parts.find((p) => owners.includes(tail9(p)))
      if (clash) return `“${clash}” আপনার নিজের নম্বর — এটা ব্লক করা যাবে না।`
    }
    return null
  }

  // text
  if (def.key === 'phone_moh_class' && value && !/^[A-Za-z0-9_-]{1,40}$/.test(value)) {
    return 'ক্লাসের নামে শুধু ইংরেজি অক্ষর, সংখ্যা, - আর _ চলবে।'
  }
  if (value.length > 300) return 'অনেক লম্বা হয়ে গেছে।'
  return null
}

/**
 * A warning is NOT a refusal. The concurrency cap above 2 is the one value the owner may
 * legitimately want to push past what the trunk allows (to test, or after buying channels),
 * so it warns loudly and still saves.
 */
export function warningFor(def: SettingDef, value: string): string | null {
  if (def.warnAbove == null || !def.warnNote) return null
  return Number(value) > def.warnAbove ? def.warnNote : null
}

// ── writing ──────────────────────────────────────────────────────────────────

export type WriteResult =
  | { ok: true; value: string; warning: string | null; scope: SettingDef['scope'] }
  | { ok: false; error: string }

/**
 * The only way a phone setting changes. Validates, writes, audits — in that order, so a
 * rejected value never reaches the table and an accepted one always leaves a trail.
 */
export async function writeSetting(key: string, raw: string, actor: string): Promise<WriteResult> {
  const def = findSetting(key)
  if (!def) return { ok: false, error: 'এই সেটিংটা কনসোল থেকে বদলানো যায় না।' }

  const value = String(raw ?? '').trim()
  const invalid = validateSetting(def, value)
  if (invalid) return { ok: false, error: invalid }

  const before = await readSetting(key)
  if (before === value) {
    return { ok: true, value, warning: warningFor(def, value), scope: def.scope }
  }

  try {
    await db.agentKvSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    })
  } catch (err) {
    return { ok: false, error: `সেভ করা যায়নি: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Best-effort: the change already happened, and losing the audit row must not make the
  // caller think it did not. It is logged loudly instead so a missing trail is visible.
  try {
    await db.agentAuditLog.create({
      data: {
        actionType: PHONE_SETTING_AUDIT,
        resourceId: key,
        actor,
        payload: { key, label: def.label, from: before, to: value, scope: def.scope },
      },
    })
  } catch (err) {
    console.error('[phone-settings] audit write failed for', key, err)
  }

  return { ok: true, value, warning: warningFor(def, value), scope: def.scope }
}

// ── history and revert ───────────────────────────────────────────────────────

type AuditRow = {
  id: string
  resourceId: string | null
  actor: string
  createdAt: Date
  payload: { key?: string; label?: string; from?: string; to?: string } | null
}

/**
 * Newest first. `revertable` is false once a later change to the same key exists, because
 * putting back a value that something newer has already replaced silently undoes the newer
 * change too — which is exactly the kind of surprise this section is meant to remove.
 */
export async function settingsHistory(limit = 50): Promise<HistoryRow[]> {
  let rows: AuditRow[] = []
  try {
    rows = (await db.agentAuditLog.findMany({
      where: { actionType: PHONE_SETTING_AUDIT },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    })) as AuditRow[]
  } catch {
    return []
  }

  const seen = new Set<string>()
  return rows.map((r) => {
    const key = r.payload?.key ?? r.resourceId ?? ''
    const newest = !seen.has(key)
    seen.add(key)
    return {
      id: r.id,
      key,
      label: r.payload?.label ?? key,
      from: r.payload?.from ?? '',
      to: r.payload?.to ?? '',
      actor: r.actor,
      at: r.createdAt.toISOString(),
      revertable: newest && Boolean(findSetting(key)),
    }
  })
}

/** Put one change back. Goes through writeSetting, so the revert is itself audited. */
export async function revertSetting(auditId: string, actor: string): Promise<WriteResult> {
  let row: AuditRow | null = null
  try {
    row = (await db.agentAuditLog.findUnique({ where: { id: auditId } })) as AuditRow | null
  } catch {
    row = null
  }
  if (!row || row.payload?.key == null) return { ok: false, error: 'এই পরিবর্তনটা খুঁজে পাওয়া যায়নি।' }

  const key = row.payload.key
  const current = await readSetting(key)
  if (current !== (row.payload.to ?? '')) {
    return { ok: false, error: 'এরপর আরেকবার বদলানো হয়েছে — ইতিহাসের উপরের পরিবর্তনটা আগে ফেরান।' }
  }
  return writeSetting(key, row.payload.from ?? '', actor)
}

// ── what the gateway pulls ───────────────────────────────────────────────────

export type GatewayConfig = {
  transferRounds: number
  transferRingTimeout: number
  ringTimeout: number
  maxConcurrent: number
  voicemailMaxSecs: number
  mohClass: string
  /** Comma-separated. The gateway refuses these BEFORE answering, so they cost nothing. */
  blocklist: string
}

/**
 * The gateway-scoped values, in the shape the gateway wants them.
 *
 * It pulls this once a minute and falls back to its own env on any failure, so this endpoint
 * being down changes nothing about how calls behave. Note the audio tuning is NOT here and
 * never will be: it is a code default in git precisely so it cannot be changed remotely.
 */
export async function gatewayConfigPayload(): Promise<GatewayConfig> {
  const m = await readSettingMap([
    'phone_ring_rounds',
    'phone_ring_member_timeout',
    'phone_outbound_ring_timeout',
    'phone_max_concurrent',
    'phone_voicemail_max_secs',
    'phone_moh_class',
    'blocked_callers',
  ])
  const num = (key: string, fallback: number) => {
    const n = Number(m[key])
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
  }
  return {
    transferRounds: num('phone_ring_rounds', 2),
    transferRingTimeout: num('phone_ring_member_timeout', 30),
    ringTimeout: num('phone_outbound_ring_timeout', 45),
    maxConcurrent: num('phone_max_concurrent', 2),
    voicemailMaxSecs: num('phone_voicemail_max_secs', 120),
    mohClass: m.phone_moh_class ?? '',
    blocklist: m.blocked_callers ?? '',
  }
}

/**
 * When the gateway last pulled. Stored by the pull endpoint itself; the screen shows it so a
 * gateway-scoped change can be seen to have LANDED rather than merely been saved. Without
 * this the owner would have no way to tell a config that arrived from one that did not.
 */
export const GATEWAY_PULL_KEY = 'phone_gateway_pulled_at'

export async function markGatewayPull(): Promise<void> {
  try {
    const value = new Date().toISOString()
    await db.agentKvSetting.upsert({
      where: { key: GATEWAY_PULL_KEY },
      create: { key: GATEWAY_PULL_KEY, value },
      update: { value },
    })
  } catch { /* a missed timestamp must never fail the gateway's config pull */ }
}

export async function lastGatewayPull(): Promise<string | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: GATEWAY_PULL_KEY } })
    return typeof row?.value === 'string' ? row.value : null
  } catch {
    return null
  }
}
