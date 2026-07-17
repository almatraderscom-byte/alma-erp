/**
 * Phase 56 — adapter contract + registry lifecycle tests.
 * Exit gates: no adapter is ready from connection alone (sandbox first);
 * owner can inspect, pause, revoke, and delete retained data.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { assertAdapterContract, runAdapterSandbox, type ServiceAdapter } from '@/agent/lib/integrations/service-adapter'
import {
  assertOpAllowed,
  clearServiceAdapters,
  connectService,
  deleteServiceData,
  inspectServiceConnections,
  markServiceReady,
  pauseService,
  registerServiceAdapter,
  resumeService,
  revokeService,
  runServiceSandboxGate,
  type ConnectionDb,
  type ServiceConnectionRow,
} from '@/agent/lib/integrations/service-registry'
import { makePersonalRecordsAdapter } from '@/agent/lib/personal-os'
import { makeErpOrdersAdapter } from '@/agent/lib/business-os'

/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeConnectionDb implements ConnectionDb {
  rows: ServiceConnectionRow[] = []
  agentServiceConnection = {
    upsert: async ({ where, create, update }: any): Promise<ServiceConnectionRow> => {
      const existing = this.rows.find((r) => r.service === where.service)
      if (existing) {
        Object.assign(existing, update)
        return { ...existing }
      }
      const row: ServiceConnectionRow = {
        id: randomUUID(),
        service: create.service,
        scope: create.scope,
        status: create.status ?? 'disconnected',
        grantedOps: create.grantedOps ?? [],
        readiness: create.readiness ?? 'sandbox_pending',
        health: create.health ?? null,
        retentionDays: create.retentionDays ?? 90,
        connectedAt: create.connectedAt ?? null,
        pausedAt: null,
        revokedAt: null,
        dataDeletedAt: null,
      }
      this.rows.push(row)
      return { ...row }
    },
    findUnique: async ({ where }: any) => {
      const r = this.rows.find((x) => x.service === where.service)
      return r ? { ...r } : null
    },
    findMany: async () => this.rows.map((r) => ({ ...r })),
    update: async ({ where, data }: any) => {
      const r = this.rows.find((x) => x.service === where.service)!
      Object.assign(r, data)
      return { ...r }
    },
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let db: FakeConnectionDb

beforeEach(() => {
  clearServiceAdapters()
  db = new FakeConnectionDb()
})

describe('adapter contract enforcement', () => {
  it('the two shipped adapters satisfy the full contract', () => {
    expect(assertAdapterContract(makePersonalRecordsAdapter())).toEqual([])
    expect(assertAdapterContract(makeErpOrdersAdapter())).toEqual([])
  })

  it('rejects adapters missing proof/idempotency/undo declarations', () => {
    const bad: ServiceAdapter = {
      service: 'bad-adapter',
      scope: 'personal',
      capabilities: () => [
        { op: 'do_write', mode: 'write', risk: 'R1', labelBn: 'কিছু লেখা', dataClass: 'personal', rateLimitPerMin: 10 } as never,
      ],
      health: async () => ({ ok: true, detail: '' }),
      read: async () => ({ ok: false, error: 'x' }),
      stage: async () => ({ ok: false, error: 'x' }),
      write: async () => ({ ok: false, state: 'denied', runId: 'x', replayed: false }),
      sandboxCases: () => [],
      disconnect: async () => {},
    }
    const problems = assertAdapterContract(bad)
    expect(problems.some((p) => p.includes('proof'))).toBe(true)
    expect(problems.some((p) => p.includes('idempotency'))).toBe(true)
    expect(problems.some((p) => p.includes('sandbox'))).toBe(true)
    expect(() => registerServiceAdapter(bad)).toThrow(/violates the contract/)
  })

  it('sandbox suites pass for both adapters', async () => {
    const p = await runAdapterSandbox(makePersonalRecordsAdapter())
    expect(p.allPassed).toBe(true)
    const b = await runAdapterSandbox(makeErpOrdersAdapter())
    expect(b.allPassed).toBe(true)
  })
})

describe('connection lifecycle (exit gates)', () => {
  it('OAuth/connect alone NEVER yields a live service — sandbox then explicit ready', async () => {
    registerServiceAdapter(makePersonalRecordsAdapter())
    await connectService('personal-records', ['list_bills', 'create_reminder'], db)

    // Connected but sandbox_pending → op refused.
    let gate = await assertOpAllowed('personal-records', 'list_bills', db)
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('sandbox')

    // Sandbox passes → still not live until the owner promotes.
    const report = await runServiceSandboxGate('personal-records', db)
    expect(report.allPassed).toBe(true)
    gate = await assertOpAllowed('personal-records', 'list_bills', db)
    expect(gate.allowed).toBe(false)

    expect(await markServiceReady('personal-records', db)).toBe(true)
    gate = await assertOpAllowed('personal-records', 'list_bills', db)
    expect(gate.allowed).toBe(true)
  })

  it('least privilege: ungranted ops are refused even when live', async () => {
    registerServiceAdapter(makePersonalRecordsAdapter())
    await connectService('personal-records', ['list_bills'], db)
    await runServiceSandboxGate('personal-records', db)
    await markServiceReady('personal-records', db)
    const gate = await assertOpAllowed('personal-records', 'create_reminder', db)
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('least privilege')
  })

  it('granting an undeclared op is rejected at connect time', async () => {
    registerServiceAdapter(makePersonalRecordsAdapter())
    await expect(connectService('personal-records', ['transfer_money'], db)).rejects.toThrow(/not declared/)
  })

  it('owner can inspect, pause, resume, revoke, and delete retained data', async () => {
    registerServiceAdapter(makePersonalRecordsAdapter())
    registerServiceAdapter(makeErpOrdersAdapter())
    await connectService('personal-records', ['list_bills'], db)
    await connectService('erp-orders', ['order_summary'], db)
    await runServiceSandboxGate('erp-orders', db)
    await markServiceReady('erp-orders', db)

    const view = await inspectServiceConnections(db)
    expect(view).toHaveLength(2)
    expect(view.find((v) => v.service === 'erp-orders')?.live).toBe(true)
    expect(view.find((v) => v.service === 'personal-records')?.live).toBe(false)

    expect(await pauseService('erp-orders', db)).toBe(true)
    expect((await assertOpAllowed('erp-orders', 'order_summary', db)).allowed).toBe(false)
    expect(await resumeService('erp-orders', db)).toBe(true)
    expect((await assertOpAllowed('erp-orders', 'order_summary', db)).allowed).toBe(true)

    expect(await revokeService('erp-orders', db)).toBe(true)
    expect((await assertOpAllowed('erp-orders', 'order_summary', db)).allowed).toBe(false)

    expect(await deleteServiceData('erp-orders', db)).toBe(true)
    const after = await db.agentServiceConnection.findUnique({ where: { service: 'erp-orders' } })
    expect(after?.dataDeletedAt).not.toBeNull()
    expect(after?.health).toBeNull()
  })

  it('connection store failure fails closed', async () => {
    registerServiceAdapter(makePersonalRecordsAdapter())
    const broken: ConnectionDb = {
      agentServiceConnection: {
        upsert: async () => { throw new Error('db down') },
        findUnique: async () => { throw new Error('db down') },
        findMany: async () => { throw new Error('db down') },
        update: async () => { throw new Error('db down') },
      },
    }
    const gate = await assertOpAllowed('personal-records', 'list_bills', broken)
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('fail closed')
  })
})
