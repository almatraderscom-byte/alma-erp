/**
 * Phase 56 — service connection registry + lifecycle.
 *
 * State machine per service (agent_service_connections):
 *   disconnected → sandbox → connected(paused ⇄) → revoked
 *   readiness: sandbox_pending → sandbox_passed → ready
 *
 * HARD RULE: 'ready' is reachable ONLY through a passing sandbox report —
 * an OAuth/connection success alone never enables live capability. The owner
 * can inspect, pause, revoke, and delete retained data at any time.
 */
import { prisma } from '@/lib/prisma'
import {
  assertAdapterContract,
  runAdapterSandbox,
  type SandboxReport,
  type ServiceAdapter,
} from './service-adapter'

// ── Adapter registry (code) ───────────────────────────────────────────────────

const adapters = new Map<string, ServiceAdapter>()

export function registerServiceAdapter(adapter: ServiceAdapter): void {
  const problems = assertAdapterContract(adapter)
  if (problems.length > 0) {
    throw new Error(`adapter ${adapter.service} violates the contract: ${problems.join('; ')}`)
  }
  adapters.set(adapter.service, adapter)
}

export function getServiceAdapter(service: string): ServiceAdapter | undefined {
  return adapters.get(service)
}

export function listServiceAdapters(): ServiceAdapter[] {
  return [...adapters.values()]
}

/** Test hook. */
export function clearServiceAdapters(): void {
  adapters.clear()
}

// ── Connection rows (DB) — injectable for tests ─────────────────────────────

export interface ServiceConnectionRow {
  id: string
  service: string
  scope: string
  status: string
  grantedOps: unknown
  readiness: string
  health: unknown
  retentionDays: number
  connectedAt: Date | null
  pausedAt: Date | null
  revokedAt: Date | null
  dataDeletedAt: Date | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ConnectionDb {
  agentServiceConnection: {
    upsert(args: { where: any; create: any; update: any }): Promise<ServiceConnectionRow>
    findUnique(args: { where: any }): Promise<ServiceConnectionRow | null>
    findMany(args?: any): Promise<ServiceConnectionRow[]>
    update(args: { where: any; data: any }): Promise<ServiceConnectionRow>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function defaultConnectionDb(): ConnectionDb {
  return prisma as unknown as ConnectionDb
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Connect a service with the LEAST-PRIVILEGE op subset the owner granted.
 * Lands in status 'sandbox' / readiness 'sandbox_pending' — never live.
 */
export async function connectService(
  service: string,
  grantedOps: string[],
  db: ConnectionDb = defaultConnectionDb(),
): Promise<ServiceConnectionRow> {
  const adapter = adapters.get(service)
  if (!adapter) throw new Error(`unknown service adapter: ${service}`)
  const declared = new Set(adapter.capabilities().map((c) => c.op))
  const invalid = grantedOps.filter((op) => !declared.has(op))
  if (invalid.length > 0) throw new Error(`granted ops not declared by ${service}: ${invalid.join(', ')}`)

  return db.agentServiceConnection.upsert({
    where: { service },
    create: {
      service,
      scope: adapter.scope,
      status: 'sandbox',
      grantedOps,
      readiness: 'sandbox_pending',
      connectedAt: new Date(),
    },
    update: {
      status: 'sandbox',
      grantedOps,
      readiness: 'sandbox_pending',
      connectedAt: new Date(),
      revokedAt: null,
      pausedAt: null,
    },
  })
}

/**
 * Run the sandbox gate. ALL cases must pass to reach readiness
 * 'sandbox_passed' + status 'connected'; any failure keeps the service in
 * sandbox with the report stored in health.
 */
export async function runServiceSandboxGate(
  service: string,
  db: ConnectionDb = defaultConnectionDb(),
): Promise<SandboxReport> {
  const adapter = adapters.get(service)
  if (!adapter) throw new Error(`unknown service adapter: ${service}`)
  const row = await db.agentServiceConnection.findUnique({ where: { service } })
  if (!row || row.status === 'revoked') throw new Error(`service ${service} is not connected`)

  const report = await runAdapterSandbox(adapter)
  await db.agentServiceConnection.update({
    where: { service },
    data: report.allPassed
      ? { status: 'connected', readiness: 'sandbox_passed', health: { sandbox: report } }
      : { status: 'sandbox', readiness: 'sandbox_pending', health: { sandbox: report } },
  })
  return report
}

/** Promote sandbox_passed → ready (the owner's explicit final switch). */
export async function markServiceReady(service: string, db: ConnectionDb = defaultConnectionDb()): Promise<boolean> {
  const row = await db.agentServiceConnection.findUnique({ where: { service } })
  if (!row || row.readiness !== 'sandbox_passed' || row.status !== 'connected') return false
  await db.agentServiceConnection.update({ where: { service }, data: { readiness: 'ready' } })
  return true
}

export async function pauseService(service: string, db: ConnectionDb = defaultConnectionDb()): Promise<boolean> {
  const row = await db.agentServiceConnection.findUnique({ where: { service } })
  if (!row || row.status !== 'connected') return false
  await db.agentServiceConnection.update({ where: { service }, data: { status: 'paused', pausedAt: new Date() } })
  return true
}

export async function resumeService(service: string, db: ConnectionDb = defaultConnectionDb()): Promise<boolean> {
  const row = await db.agentServiceConnection.findUnique({ where: { service } })
  if (!row || row.status !== 'paused') return false
  await db.agentServiceConnection.update({ where: { service }, data: { status: 'connected', pausedAt: null } })
  return true
}

/** Revoke: disconnect the adapter (tokens/syncs) + kill live capability. */
export async function revokeService(service: string, db: ConnectionDb = defaultConnectionDb()): Promise<boolean> {
  const adapter = adapters.get(service)
  if (adapter) await adapter.disconnect().catch(() => {})
  const row = await db.agentServiceConnection.findUnique({ where: { service } })
  if (!row) return false
  await db.agentServiceConnection.update({
    where: { service },
    data: { status: 'revoked', readiness: 'sandbox_pending', revokedAt: new Date() },
  })
  return true
}

/** Owner right: delete retained connection data (recorded with a timestamp). */
export async function deleteServiceData(service: string, db: ConnectionDb = defaultConnectionDb()): Promise<boolean> {
  const row = await db.agentServiceConnection.findUnique({ where: { service } })
  if (!row) return false
  await db.agentServiceConnection.update({
    where: { service },
    data: { health: null, dataDeletedAt: new Date() },
  })
  return true
}

/** Owner inspection view — every connection with its exact capability state. */
export async function inspectServiceConnections(db: ConnectionDb = defaultConnectionDb()): Promise<
  Array<{
    service: string
    scope: string
    status: string
    readiness: string
    grantedOps: string[]
    retentionDays: number
    live: boolean
  }>
> {
  const rows = await db.agentServiceConnection.findMany({ orderBy: { service: 'asc' } })
  return rows.map((r) => ({
    service: r.service,
    scope: r.scope,
    status: r.status,
    readiness: r.readiness,
    grantedOps: Array.isArray(r.grantedOps) ? (r.grantedOps as string[]) : [],
    retentionDays: r.retentionDays,
    live: r.status === 'connected' && r.readiness === 'ready',
  }))
}

/**
 * The runtime gate every OS call goes through: an op executes only when the
 * service is live (connected + ready) AND the op was granted (least
 * privilege). Fail closed on any doubt.
 */
export async function assertOpAllowed(
  service: string,
  op: string,
  db: ConnectionDb = defaultConnectionDb(),
): Promise<{ allowed: boolean; reason: string }> {
  try {
    const row = await db.agentServiceConnection.findUnique({ where: { service } })
    if (!row) return { allowed: false, reason: `service ${service} is not connected` }
    if (row.status !== 'connected') return { allowed: false, reason: `service ${service} is ${row.status}` }
    if (row.readiness !== 'ready') return { allowed: false, reason: `service ${service} readiness is ${row.readiness} (sandbox first)` }
    const granted = Array.isArray(row.grantedOps) ? (row.grantedOps as string[]) : []
    if (!granted.includes(op)) return { allowed: false, reason: `op ${op} was not granted (least privilege)` }
    return { allowed: true, reason: 'granted' }
  } catch (err) {
    return { allowed: false, reason: `connection store unreachable — fail closed (${err instanceof Error ? err.message : String(err)})` }
  }
}
