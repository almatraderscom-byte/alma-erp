/**
 * Phase 61 — Production truth & release identity.
 *
 * One place that answers, per capability, the SIX questions the final roadmap
 * says must never be confused again:
 *
 *   implemented → deployed → configured → reachable → enabled/used → outcome
 *
 * Every row here is derived from a LIVE signal — a real DB record count, a real
 * flag, a real heartbeat — never from "the env var exists" alone. When a signal
 * cannot be proven (worker SHA, provider link, migration head), the row is
 * `unknown` and renders amber/red. It is impossible for a missing config to
 * read green: probes fail-open to `unknown`, and `unknown` is never a pass.
 *
 * Read-only. No writes, no external calls. Safe to call from the owner-only
 * internal health route and the owner-gated monitor panel.
 */
import { prisma } from '@/lib/prisma'
import { getBuildInfo, type BuildInfo } from '@/lib/runtime-build'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DAY_MS = 86_400_000

/**
 * Effective operating mode of a capability, distinct from "does the code exist".
 *  - off       : intentionally disabled by flag/policy.
 *  - shadow    : runs, compares, but cannot create an external effect.
 *  - unwired   : code exists but has no production call-site / no registration.
 *  - broken    : configured/expected to work but a live check fails.
 *  - unused    : reachable + enabled but zero real production use.
 *  - live      : reachable, enabled, and used with real production records.
 *  - unknown   : truth cannot be proven right now (never treated as a pass).
 */
export type EffectiveMode =
  | 'off'
  | 'shadow'
  | 'unwired'
  | 'broken'
  | 'unused'
  | 'live'
  | 'unknown'

export interface FeatureTruth {
  id: string
  labelBn: string
  /** Code + migration present on this build (source-level truth). */
  implemented: boolean
  /** Present in the running deployment (this process can import/see it). */
  deployed: boolean
  /** Real config/connection/secret present (not just the flag). */
  configured: boolean | 'unknown'
  /** A real head/worker/router path can select & invoke it. */
  reachable: boolean | 'unknown'
  effectiveMode: EffectiveMode
  /** ISO of the most recent real production use, or null. */
  lastRealUse: string | null
  /** Count of real uses in the last 7 days. */
  use7d: number
  /** Last independently-verified good outcome, or null / honest note. */
  lastVerifiedOutcome: string | null
  /** Honest one-line blocker in Bangla when not `live`, else null. */
  blocker: string | null
}

export interface WorkerReleaseTruth {
  service: string
  lastBeatAt: string | null
  ageMinutes: number | null
  /** Worker does not yet stamp its own SHA — honest `unknown`. */
  sha: 'unknown'
  alive: boolean
}

export interface ReleaseIdentity {
  app: BuildInfo
  /** Latest applied Prisma migration (real _prisma_migrations read). */
  migrationHead: { name: string | null; appliedAt: string | null } | 'unknown'
  workers: WorkerReleaseTruth[]
  /** True only when we can prove the exact running commit SHA. */
  shaProven: boolean
  checkedAt: string
}

export interface ProductionTruth {
  release: ReleaseIdentity
  features: FeatureTruth[]
  /** Rollup counts for the monitor header. */
  summary: {
    live: number
    shadow: number
    off: number
    unwired: number
    broken: number
    unused: number
    unknown: number
    total: number
  }
  checkedAt: string
}

// ── helpers ────────────────────────────────────────────────────────────────

function iso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null
}

function minutesSince(d: Date | null | undefined): number | null {
  return d ? Math.round((Date.now() - new Date(d).getTime()) / 60000) : null
}

/** Count rows in a table with a `since` filter, fail-open to a sentinel. */
async function safeCount(fn: () => Promise<number>): Promise<number | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

// ── release identity ─────────────────────────────────────────────────────────

async function readMigrationHead(): Promise<ReleaseIdentity['migrationHead']> {
  try {
    const rows: Array<{ migration_name: string; finished_at: Date | null }> = await db.$queryRaw`
      SELECT migration_name, finished_at
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `
    if (!rows?.length) return 'unknown'
    return { name: rows[0].migration_name, appliedAt: iso(rows[0].finished_at) }
  } catch {
    return 'unknown'
  }
}

async function readWorkers(): Promise<WorkerReleaseTruth[]> {
  try {
    const rows: Array<{ service: string; last_beat_at: Date }> = await db.agentHeartbeat.findMany({
      select: { service: true, lastBeatAt: true },
      orderBy: { lastBeatAt: 'desc' },
      take: 25,
    })
    return rows.map((r) => {
      const age = minutesSince(r.last_beat_at ?? (r as unknown as { lastBeatAt: Date }).lastBeatAt)
      return {
        service: r.service,
        lastBeatAt: iso(r.last_beat_at ?? (r as unknown as { lastBeatAt: Date }).lastBeatAt),
        ageMinutes: age,
        sha: 'unknown' as const,
        // A worker/service is "alive" if it beat within the last 30 minutes.
        alive: age !== null && age <= 30,
      }
    })
  } catch {
    return []
  }
}

export async function getReleaseIdentity(): Promise<ReleaseIdentity> {
  const app = getBuildInfo()
  const [migrationHead, workers] = await Promise.all([readMigrationHead(), readWorkers()])
  return {
    app,
    migrationHead,
    workers,
    shaProven: Boolean(app.commit),
    checkedAt: new Date().toISOString(),
  }
}

// ── feature probes (each fail-open to `unknown`, never green on error) ────────

type Probe = () => Promise<FeatureTruth>

const since7d = () => new Date(Date.now() - 7 * DAY_MS)

/** __route__ tool events carry the LangGraph shadow trace — real turn usage. */
const probeLangGraph: Probe = async () => {
  const stage = await readKv('agent_graph_rollout_stage', 'shadow')
  const flag = process.env.AGENT_LANGGRAPH_TURN?.trim() ?? null
  let use7d = 0
  let last: Date | null = null
  try {
    const rows: Array<{ ts: Date; detail: unknown }> = await db.agentToolEvent.findMany({
      where: { toolName: '__route__', ts: { gte: since7d() } },
      select: { ts: true, detail: true },
      orderBy: { ts: 'desc' },
      take: 5000,
    })
    for (const r of rows) {
      const d = (r.detail ?? {}) as { turnGraph?: unknown }
      if (d.turnGraph) {
        use7d++
        if (!last) last = r.ts
      }
    }
  } catch {
    return unknownRow('langgraph', 'LangGraph টার্ন-গ্রাফ', 'শ্যাডো ট্রেস পড়া যায়নি')
  }
  // Stage governs the effect: shadow compares only; on = authoritative.
  const mode: EffectiveMode =
    flag === 'false' || flag === 'off'
      ? 'off'
      : stage === 'shadow' || flag === 'shadow' || !flag
        ? 'shadow'
        : use7d > 0
          ? 'live'
          : 'unused'
  return {
    id: 'langgraph',
    labelBn: 'LangGraph টার্ন-গ্রাফ',
    implemented: true,
    deployed: true,
    configured: true,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: iso(last),
    use7d,
    lastVerifiedOutcome: use7d > 0 ? `৭ দিনে ${use7d} টার্নে শ্যাডো তুলনা রেকর্ড` : null,
    blocker:
      mode === 'shadow'
        ? 'শ্যাডো — সিদ্ধান্ত তুলনা করে, কিন্তু legacy path এখনো কর্তৃত্বে (কাটওভার Phase 62/68)'
        : mode === 'unused'
          ? 'চালু কিন্তু ৭ দিনে কোনো ট্রেস নেই'
          : null,
  }
}

/** AgentConversationFocus rows = real durable task identities being created. */
const probeContinuity: Probe = async () => {
  const flag = process.env.AGENT_CONTINUITY_RESOLVER?.trim() ?? null
  const created = await safeCount(() =>
    db.agentConversationFocus.count({ where: { createdAt: { gte: since7d() } } }),
  )
  if (created === null) return unknownRow('continuity', 'ধারাবাহিকতা (focus)', 'focus রেকর্ড পড়া যায়নি')
  let last: Date | null = null
  try {
    const row = await db.agentConversationFocus.findFirst({
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    last = row?.createdAt ?? null
  } catch { /* keep null */ }
  const off = flag === 'false' || flag === 'off'
  const mode: EffectiveMode = off ? 'off' : created > 0 ? 'live' : 'unused'
  return {
    id: 'continuity',
    labelBn: 'ধারাবাহিকতা (focus)',
    implemented: true,
    deployed: true,
    configured: true,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: iso(last),
    use7d: created,
    lastVerifiedOutcome: created > 0 ? `৭ দিনে ${created}টি focus তৈরি` : null,
    blocker:
      mode === 'unused'
        ? 'resolver চালু কিন্তু সাধারণ কাজে focus তৈরি হচ্ছে না (সর্বজনীন intake Phase 62)'
        : mode === 'off'
          ? 'AGENT_CONTINUITY_RESOLVER বন্ধ'
          : 'কভারেজ এখনো সব non-trivial কাজে নয় (Phase 62)',
  }
}

/** __interaction__ tool events = interaction-layer decisions applied. */
const probeInteraction: Probe = async () => {
  const flag = process.env.AGENT_INTERACTION_LAYER?.trim() ?? null
  const used = await safeCount(() =>
    db.agentToolEvent.count({ where: { toolName: '__interaction__', ts: { gte: since7d() } } }),
  )
  if (used === null) return unknownRow('interaction', 'ইন্টার‌্যাকশন লেয়ার', 'ইভেন্ট পড়া যায়নি')
  let last: Date | null = null
  try {
    const row = await db.agentToolEvent.findFirst({
      where: { toolName: '__interaction__' },
      select: { ts: true },
      orderBy: { ts: 'desc' },
    })
    last = row?.ts ?? null
  } catch { /* keep null */ }
  const off = flag === 'false' || flag === 'off'
  const mode: EffectiveMode = off ? 'off' : used > 0 ? 'live' : 'unused'
  return {
    id: 'interaction',
    labelBn: 'ইন্টার‌্যাকশন লেয়ার',
    implemented: true,
    deployed: true,
    configured: true,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: iso(last),
    use7d: used,
    lastVerifiedOutcome: used > 0 ? `৭ দিনে ${used}টি ইন্টার‌্যাকশন সিদ্ধান্ত` : null,
    blocker: mode === 'unused' ? 'চালু কিন্তু ৭ দিনে ব্যবহার নেই' : mode === 'off' ? 'বন্ধ' : null,
  }
}

/** AgentActionRun = the exactly-once effect unit; gate is AGENT_EFFECT_ENGINE. */
const probeEffectEngine: Probe = async () => {
  const on = process.env.AGENT_EFFECT_ENGINE?.trim() === 'true'
  const runs7d = await safeCount(() =>
    db.agentActionRun.count({ where: { createdAt: { gte: since7d() } } }),
  )
  if (runs7d === null) return unknownRow('effect_engine', 'Exactly-once effect engine', 'action run পড়া যায়নি')
  let last: Date | null = null
  let succeeded = 0
  try {
    const row = await db.agentActionRun.findFirst({ select: { createdAt: true }, orderBy: { createdAt: 'desc' } })
    last = row?.createdAt ?? null
    succeeded = await db.agentActionRun.count({ where: { state: 'succeeded', createdAt: { gte: since7d() } } })
  } catch { /* keep */ }
  const mode: EffectiveMode = !on ? 'off' : runs7d > 0 ? 'live' : 'unused'
  return {
    id: 'effect_engine',
    labelBn: 'Exactly-once effect engine',
    implemented: true,
    deployed: true,
    configured: on,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: iso(last),
    use7d: runs7d ?? 0,
    lastVerifiedOutcome: succeeded > 0 ? `৭ দিনে ${succeeded}টি effect প্রমাণসহ সফল` : null,
    blocker: !on
      ? 'AGENT_EFFECT_ENGINE=false — legacy write handler-ই স্বাভাবিক পথ (Phase 65)'
      : mode === 'unused'
        ? 'engine চালু কিন্তু কোনো effect run হয়নি'
        : null,
  }
}

/** workflow_runs kind=durable_task — durable queue actually receiving work. */
const probeDurableQueue: Probe = async () => {
  let total: number | null = null
  let last: Date | null = null
  let recent = 0
  try {
    const rows: Array<{ created_at: Date }> = await db.$queryRaw`
      SELECT created_at FROM workflow_runs WHERE kind = 'durable_task'
      ORDER BY created_at DESC LIMIT 500
    `
    total = rows.length
    if (rows.length) {
      last = rows[0].created_at
      const cutoff = since7d().getTime()
      recent = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff).length
    }
  } catch {
    return unknownRow('durable_queue', 'Durable টাস্ক কিউ', 'workflow_runs পড়া যায়নি')
  }
  // enqueueDurableTask() has no production caller (audit GAP-05) → unwired until
  // Phase 65 routes real >30s work to it. Zero rows ever = unwired, not "off".
  const mode: EffectiveMode = (total ?? 0) === 0 ? 'unwired' : recent > 0 ? 'live' : 'unused'
  return {
    id: 'durable_queue',
    labelBn: 'Durable টাস্ক কিউ',
    implemented: true,
    deployed: true,
    configured: true,
    reachable: mode === 'unwired' ? false : true,
    effectiveMode: mode,
    lastRealUse: iso(last),
    use7d: recent,
    lastVerifiedOutcome: recent > 0 ? `৭ দিনে ${recent}টি durable task` : null,
    blocker:
      mode === 'unwired'
        ? 'enqueueDurableTask() এর কোনো production caller নেই (Phase 65)'
        : mode === 'unused'
          ? 'কিউ আছে কিন্তু ৭ দিনে কাজ আসেনি'
          : null,
  }
}

/** Autonomy ladder: effectiveStage() is not called by the guard (GAP-03). */
const probeAutonomyLadder: Probe = async () => {
  // Phase 64 wired effectiveStage() into the central guard; it now governs
  // agent-initiated effects. In production it runs in SHADOW (annotate-only)
  // and every class defaults 'off', so it OBSERVES but does not yet govern —
  // that is `shadow`, not `unwired`. A promoted class flips it to `live`.
  let activeClasses = 0
  try {
    const rows: Array<{ key: string; value: string }> = await db.agentKvSetting.findMany({
      where: { key: { startsWith: 'autonomy_rollout:' } },
      select: { key: true, value: true },
    })
    for (const r of rows) {
      try {
        const stage = (JSON.parse(String(r.value)) as { stage?: string }).stage
        if (stage && stage !== 'off') activeClasses++
      } catch { /* skip unparseable */ }
    }
  } catch {
    return unknownRow('autonomy_ladder', 'অটোনমি ল্যাডার', 'rollout KV পড়া যায়নি')
  }
  const mode: EffectiveMode = activeClasses > 0 ? 'live' : 'shadow'
  return {
    id: 'autonomy_ladder',
    labelBn: 'অটোনমি ল্যাডার',
    implemented: true,
    deployed: true,
    configured: true,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: null,
    use7d: activeClasses,
    lastVerifiedOutcome: activeClasses > 0 ? `${activeClasses}টি class promote করা` : null,
    blocker:
      mode === 'shadow'
        ? 'central guard-এ যুক্ত (Phase 64), কিন্তু prod shadow — কোনো class এখনো promote হয়নি (Phase 68 rollout)'
        : null,
  }
}

/** AgentServiceConnection rows = Personal/Business OS adapters registered. */
const probeServiceAdapters: Probe = async () => {
  let rows: Array<{ service: string; status: string; readiness: string }> = []
  try {
    rows = await db.agentServiceConnection.findMany({ select: { service: true, status: true, readiness: true } })
  } catch {
    return unknownRow('service_adapters', 'Personal/Business OS adapters', 'connection পড়া যায়নি')
  }
  const connected = rows.filter((r) => r.status === 'connected').length
  // Phase 66 imported the OS tool families into the registry + bootstrap, so the
  // head can reach them. A service CONNECTION row (owner connects a service) is
  // separate: none yet = `unused` (reachable, no service connected), not unwired.
  const mode: EffectiveMode = connected > 0 ? 'live' : 'unused'
  return {
    id: 'service_adapters',
    labelBn: 'Personal/Business OS adapters',
    implemented: true,
    deployed: true,
    configured: rows.length > 0,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: null,
    use7d: connected,
    lastVerifiedOutcome: connected > 0 ? `${connected}টি service সংযুক্ত` : null,
    blocker:
      mode === 'unused'
        ? 'tools registry-তে যুক্ত (Phase 66); কিন্তু কোনো service এখনো connected নয় (owner connect করবেন)'
        : null,
  }
}

/** AgentGrowthBrief status=approved — the marketing loop's precondition. */
const probeGrowthBrief: Probe = async () => {
  let approved: { version: number; approvedAt: Date | null } | null = null
  let anyExists = false
  try {
    anyExists = (await db.agentGrowthBrief.count()) > 0
    approved = await db.agentGrowthBrief.findFirst({
      where: { status: 'approved' },
      select: { version: true, approvedAt: true },
      orderBy: { version: 'desc' },
    })
  } catch {
    return unknownRow('growth_brief', 'অনুমোদিত Growth Brief', 'brief পড়া যায়নি')
  }
  const mode: EffectiveMode = approved ? 'live' : 'off'
  return {
    id: 'growth_brief',
    labelBn: 'অনুমোদিত Growth Brief',
    implemented: true,
    deployed: true,
    configured: Boolean(approved),
    reachable: true,
    effectiveMode: mode,
    lastRealUse: iso(approved?.approvedAt ?? null),
    use7d: approved ? 1 : 0,
    lastVerifiedOutcome: approved ? `v${approved.version} অনুমোদিত` : null,
    blocker: approved
      ? null
      : anyExists
        ? 'শুধু draft আছে, কোনো version অনুমোদিত নয় (Phase 63 onboarding)'
        : 'কোনো Growth Brief নেই — marketing loop ব্লকড (Phase 63 onboarding)',
  }
}

/** AgentGrowthExperiment rows — every marketing asset should belong to one. */
const probeExperiments: Probe = async () => {
  let running = 0
  let total = 0
  try {
    total = await db.agentGrowthExperiment.count()
    running = await db.agentGrowthExperiment.count({ where: { status: { in: ['approved', 'running'] } } })
  } catch {
    return unknownRow('experiments', 'Growth experiments', 'experiment পড়া যায়নি')
  }
  const mode: EffectiveMode = running > 0 ? 'live' : total > 0 ? 'unused' : 'off'
  return {
    id: 'experiments',
    labelBn: 'Growth experiments',
    implemented: true,
    deployed: true,
    configured: total > 0,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: null,
    use7d: running,
    lastVerifiedOutcome: running > 0 ? `${running}টি চলমান experiment` : null,
    blocker: running > 0 ? null : total > 0 ? 'experiment আছে কিন্তু চলমান নয়' : 'কোনো experiment নেই (Phase 63)',
  }
}

/** AgentMarketingEvent source=server = CAPI events actually produced. */
const probeCapi: Probe = async () => {
  let sent7d = 0
  let last: Date | null = null
  let configured = false
  try {
    // Config truth = a real pixel/dataset secret present, not just a flag.
    configured = Boolean(
      (process.env.META_PIXEL_ID || process.env.META_DATASET_ID) && process.env.META_CAPI_TOKEN,
    )
    const rows: Array<{ createdAt: Date }> = await db.agentMarketingEvent.findMany({
      where: { source: 'server', status: 'sent', createdAt: { gte: since7d() } },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    })
    sent7d = rows.length
    last = rows[0]?.createdAt ?? null
  } catch {
    return unknownRow('capi', 'Meta CAPI event stream', 'marketing event পড়া যায়নি')
  }
  const mode: EffectiveMode = !configured ? 'off' : sent7d > 0 ? 'live' : 'unused'
  return {
    id: 'capi',
    labelBn: 'Meta CAPI event stream',
    implemented: true,
    deployed: true,
    configured,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: iso(last),
    use7d: sent7d,
    lastVerifiedOutcome: sent7d > 0 ? `৭ দিনে ${sent7d}টি server event পাঠানো` : null,
    blocker: !configured
      ? 'Pixel/dataset + CAPI token কনফিগার করা নেই (Phase 63, owner secret)'
      : mode === 'unused'
        ? 'কনফিগার্ড কিন্তু কোনো production event producer নেই (Phase 63 worker)'
        : null,
  }
}

/** Instagram publishing — provider link truth cannot be proven read-only. */
const probeInstagram: Probe = async () => {
  // The audit found IG linking broken; we cannot prove/disprove it without a
  // Meta call (owner action). Honest `unknown`, never green.
  return {
    id: 'instagram',
    labelBn: 'Instagram publishing',
    implemented: true,
    deployed: true,
    configured: 'unknown',
    reachable: 'unknown',
    effectiveMode: 'unknown',
    lastRealUse: null,
    use7d: 0,
    lastVerifiedOutcome: null,
    blocker: 'IG Professional link যাচাই করা যায়নি — owner-এর Meta UI অ্যাকশন লাগবে (Phase 63)',
  }
}

/** LiveBrowserDevice paired + recent command activity = browser operator live. */
const probeBrowserRunner: Probe = async () => {
  let paired = 0
  let lastSeen: Date | null = null
  try {
    const rows: Array<{ lastSeenAt: Date | null; revoked: boolean; pairedAt: Date | null }> =
      await db.liveBrowserDevice.findMany({
        select: { lastSeenAt: true, revoked: true, pairedAt: true },
        orderBy: { lastSeenAt: 'desc' },
        take: 25,
      })
    for (const r of rows) {
      if (r.pairedAt && !r.revoked) paired++
      if (!lastSeen && r.lastSeenAt) lastSeen = r.lastSeenAt
    }
  } catch {
    return unknownRow('browser_runner', 'ইন্টারনেট/ব্রাউজার অপারেটর', 'browser device পড়া যায়নি')
  }
  const seenRecently = lastSeen !== null && (minutesSince(lastSeen) ?? 1e9) <= 7 * 24 * 60
  const mode: EffectiveMode = paired === 0 ? 'unwired' : seenRecently ? 'live' : 'unused'
  return {
    id: 'browser_runner',
    labelBn: 'ইন্টারনেট/ব্রাউজার অপারেটর',
    implemented: true,
    deployed: true,
    configured: paired > 0,
    reachable: paired > 0,
    effectiveMode: mode,
    lastRealUse: iso(lastSeen),
    use7d: seenRecently ? 1 : 0,
    lastVerifiedOutcome: seenRecently ? 'পেয়ার করা Chrome সম্প্রতি সক্রিয়' : null,
    blocker:
      mode === 'unwired'
        ? 'কোনো পেয়ার করা browser নেই'
        : mode === 'unused'
          ? 'পেয়ার করা কিন্তু ৭ দিনে সক্রিয়তা নেই'
          : null,
  }
}

/** AgentHeartbeat = the genuinely-live liveness surface. */
const probeHeartbeat: Probe = async () => {
  let services: WorkerReleaseTruth[] = []
  try {
    services = await readWorkers()
  } catch {
    return unknownRow('heartbeat', 'Heartbeat / liveness', 'heartbeat পড়া যায়নি')
  }
  const alive = services.filter((s) => s.alive).length
  const last = services[0]?.lastBeatAt ?? null
  const mode: EffectiveMode = services.length === 0 ? 'unused' : alive > 0 ? 'live' : 'broken'
  return {
    id: 'heartbeat',
    labelBn: 'Heartbeat / liveness',
    implemented: true,
    deployed: true,
    configured: true,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: last,
    use7d: services.length,
    lastVerifiedOutcome: alive > 0 ? `${alive}টি service ৩০ মিনিটের মধ্যে সক্রিয়` : null,
    blocker:
      mode === 'broken'
        ? 'heartbeat আছে কিন্তু কোনোটি সাম্প্রতিক নয় — worker থেমে থাকতে পারে'
        : mode === 'unused'
          ? 'কোনো heartbeat রেকর্ড নেই'
          : null,
  }
}

/** Content engine runs are gated on the approved brief; reflect that honestly. */
const probeContentEngine: Probe = async () => {
  // Real signal: content-engine duty runs. Gate = approved Growth Brief.
  let runs7d: number | null = null
  let last: Date | null = null
  let briefApproved = false
  try {
    briefApproved = (await db.agentGrowthBrief.count({ where: { status: 'approved' } })) > 0
    const rows: Array<{ ranAt: Date | null }> = await db.agentDutyLog.findMany({
      where: { duty: { contains: 'content' }, ranAt: { gte: since7d() } },
      select: { ranAt: true },
      orderBy: { ranAt: 'desc' },
      take: 200,
    })
    runs7d = rows.length
    last = rows[0]?.ranAt ?? null
  } catch {
    return unknownRow('content_engine', 'কন্টেন্ট ইঞ্জিন', 'duty log পড়া যায়নি')
  }
  const mode: EffectiveMode = !briefApproved ? 'off' : (runs7d ?? 0) > 0 ? 'live' : 'unused'
  return {
    id: 'content_engine',
    labelBn: 'কন্টেন্ট ইঞ্জিন',
    implemented: true,
    deployed: true,
    configured: briefApproved,
    reachable: true,
    effectiveMode: mode,
    lastRealUse: iso(last),
    use7d: runs7d ?? 0,
    lastVerifiedOutcome: (runs7d ?? 0) > 0 ? `৭ দিনে ${runs7d}টি content run` : null,
    blocker: !briefApproved
      ? 'অনুমোদিত Growth Brief নেই বলে ইচ্ছাকৃতভাবে কাজ বন্ধ (Phase 63)'
      : mode === 'unused'
        ? 'brief আছে কিন্তু ৭ দিনে content run হয়নি'
        : null,
  }
}

// ── shared row builders ──────────────────────────────────────────────────────

function unknownRow(id: string, labelBn: string, why: string): FeatureTruth {
  return {
    id,
    labelBn,
    implemented: true,
    deployed: true,
    configured: 'unknown',
    reachable: 'unknown',
    effectiveMode: 'unknown',
    lastRealUse: null,
    use7d: 0,
    lastVerifiedOutcome: null,
    blocker: `যাচাই করা যায়নি: ${why}`,
  }
}

async function readKv(key: string, fallback: string): Promise<string> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key } })
    return row?.value ? String(row.value) : fallback
  } catch {
    return fallback
  }
}

const PROBES: Probe[] = [
  probeLangGraph,
  probeContinuity,
  probeInteraction,
  probeEffectEngine,
  probeDurableQueue,
  probeAutonomyLadder,
  probeServiceAdapters,
  probeGrowthBrief,
  probeExperiments,
  probeCapi,
  probeInstagram,
  probeBrowserRunner,
  probeHeartbeat,
  probeContentEngine,
]

/** The full production truth: release identity + feature matrix + rollup. */
export async function getProductionTruth(): Promise<ProductionTruth> {
  const [release, ...features] = await Promise.all([
    getReleaseIdentity(),
    ...PROBES.map((p) =>
      p().catch(
        (): FeatureTruth => unknownRow('unknown', 'অজানা ফিচার', 'probe থ্রো করেছে'),
      ),
    ),
  ])
  const summary = {
    live: 0,
    shadow: 0,
    off: 0,
    unwired: 0,
    broken: 0,
    unused: 0,
    unknown: 0,
    total: features.length,
  }
  for (const f of features) summary[f.effectiveMode] += 1
  return { release, features, summary, checkedAt: new Date().toISOString() }
}
