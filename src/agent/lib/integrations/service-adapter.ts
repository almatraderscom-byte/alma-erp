/**
 * Phase 56 — the SERVICE ADAPTER CONTRACT.
 *
 * Every service the personal/business OS touches (tasks, calendar, email,
 * documents, research, ERP subsystems…) is reached through ONE adapter shape:
 * capability discovery, least-privilege scopes, health, read/stage/write map,
 * risk class, idempotency, proof, undo, rate limit, data retention, and
 * disconnect/revoke. API first; controlled browser fallback only when the
 * owner allows it.
 *
 * An adapter is NEVER marked ready from OAuth/connection success alone —
 * runAdapterSandbox() must pass its declared sandbox cases first
 * (service-registry.ts enforces this in the connection state machine).
 *
 * Writes NEVER bypass the platform: every write op executes through the
 * Phase 52 guard envelope + Phase 53 effect engine, supplied by the caller
 * via the AdapterWriteContext — the adapter itself only knows HOW to perform
 * and verify the effect, not WHETHER it may run.
 */
import type { DataClass } from '@/agent/lib/policy/data-classification'
import type { EffectOutcome, EffectResultLike } from '@/agent/lib/effects/action-run'

export type AdapterScope = 'personal' | 'business'
export type AdapterOpMode = 'read' | 'stage' | 'write'
export type AdapterRisk = 'R0' | 'R1' | 'R2' | 'R3'

export interface AdapterCapability {
  /** Operation id, unique within the adapter, e.g. 'list_bills', 'create_reminder'. */
  op: string
  mode: AdapterOpMode
  risk: AdapterRisk
  /** Owner-readable Bangla label. */
  labelBn: string
  dataClass: DataClass
  /** Whole-adapter ops/minute ceiling this op counts toward. */
  rateLimitPerMin: number
  /** How the effect proves itself (write ops only). */
  proof?: 'record' | 'external'
  /** Inverse op when a clean undo exists. */
  undoOp?: string
  idempotency?: 'engine' // writes always ride the effect engine's exactly-once
}

export interface AdapterHealth {
  ok: boolean
  detail: string
}

export interface AdapterSandboxCase {
  name: string
  /** Runs against the adapter in sandbox mode; must not touch real surfaces. */
  run: (adapter: ServiceAdapter) => Promise<{ pass: boolean; detail?: string }>
}

export interface AdapterReadResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface AdapterDraft {
  ok: boolean
  /** The staged object (draft/proposal) — private until approved. */
  draft?: unknown
  error?: string
}

/**
 * Supplied by the OS layer for write ops: performs the guarded, exactly-once
 * execution. The adapter provides execute/verify; the platform provides
 * authorization + durability.
 */
export type AdapterWriteContext = {
  runEffect: (opts: {
    tool: string
    input: Record<string, unknown>
    riskTier: AdapterRisk
    execute: (info: { idempotencyKey: string; attempt: number }) => Promise<EffectResultLike>
    verify?: (result: EffectResultLike) => Promise<unknown | null>
  }) => Promise<EffectOutcome>
}

export interface ServiceAdapter {
  service: string
  scope: AdapterScope
  /** Capability discovery — the full read/stage/write map. */
  capabilities(): AdapterCapability[]
  health(): Promise<AdapterHealth>
  read(op: string, params: Record<string, unknown>): Promise<AdapterReadResult>
  /** Stage a private draft — nothing external happens. */
  stage(op: string, params: Record<string, unknown>): Promise<AdapterDraft>
  /** Perform a write THROUGH the platform's guarded effect context. */
  write(op: string, params: Record<string, unknown>, ctx: AdapterWriteContext): Promise<EffectOutcome>
  /** Sandbox cases that must pass before the adapter may be marked ready. */
  sandboxCases(): AdapterSandboxCase[]
  /** Revoke tokens / stop syncs. Must be safe to call repeatedly. */
  disconnect(): Promise<void>
}

/** Contract completeness check — CI fails registration on any gap. */
export function assertAdapterContract(adapter: ServiceAdapter): string[] {
  const problems: string[] = []
  if (!adapter.service || !/^[a-z0-9-]+$/.test(adapter.service)) problems.push('service id must be kebab-case')
  if (adapter.scope !== 'personal' && adapter.scope !== 'business') problems.push('scope must be personal|business')

  const caps = adapter.capabilities()
  if (caps.length === 0) problems.push('adapter declares no capabilities')
  const seen = new Set<string>()
  for (const c of caps) {
    if (seen.has(c.op)) problems.push(`duplicate op ${c.op}`)
    seen.add(c.op)
    if (!['read', 'stage', 'write'].includes(c.mode)) problems.push(`${c.op}: bad mode`)
    if (!['R0', 'R1', 'R2', 'R3'].includes(c.risk)) problems.push(`${c.op}: bad risk`)
    if (c.mode === 'read' && c.risk !== 'R0') problems.push(`${c.op}: reads are R0`)
    if (c.mode === 'write' && c.risk === 'R0') problems.push(`${c.op}: a write cannot be R0`)
    if (!c.labelBn || c.labelBn.length < 3) problems.push(`${c.op}: missing Bangla label`)
    if (!c.dataClass) problems.push(`${c.op}: missing data class`)
    if (!Number.isFinite(c.rateLimitPerMin) || c.rateLimitPerMin <= 0) problems.push(`${c.op}: missing rate limit`)
    if (c.mode === 'write') {
      if (!c.proof) problems.push(`${c.op}: write without proof strategy`)
      if (c.idempotency !== 'engine') problems.push(`${c.op}: write must declare idempotency 'engine'`)
      if (c.undoOp && !caps.some((x) => x.op === c.undoOp)) problems.push(`${c.op}: undoOp ${c.undoOp} not declared`)
    }
  }
  if (adapter.sandboxCases().length === 0) problems.push('adapter has no sandbox cases — cannot ever be ready')
  return problems
}

export interface SandboxReport {
  service: string
  passed: number
  failed: number
  results: Array<{ name: string; pass: boolean; detail?: string }>
  allPassed: boolean
}

/** Run the adapter's sandbox suite (the gate between 'connected' and 'ready'). */
export async function runAdapterSandbox(adapter: ServiceAdapter): Promise<SandboxReport> {
  const results: SandboxReport['results'] = []
  for (const c of adapter.sandboxCases()) {
    try {
      const r = await c.run(adapter)
      results.push({ name: c.name, pass: r.pass, detail: r.detail })
    } catch (err) {
      results.push({ name: c.name, pass: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }
  const failed = results.filter((r) => !r.pass).length
  return { service: adapter.service, passed: results.length - failed, failed, results, allPassed: failed === 0 }
}
