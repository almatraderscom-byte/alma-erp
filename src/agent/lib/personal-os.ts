/**
 * Phase 56 — PERSONAL OS: the first personal service adapter
 * ('personal-records': bills, reminders, appointments — the owner's own
 * reversible records inside the ERP database).
 *
 * API-first (in-house prisma store), fully contract-compliant:
 * reads are free, stages produce private drafts, writes ride the platform's
 * guarded exactly-once effect context, and every write declares proof + undo.
 * Storage is injectable so the sandbox suite runs against an in-memory store
 * (sandbox never touches real rows).
 */
import type {
  AdapterCapability,
  AdapterDraft,
  AdapterHealth,
  AdapterReadResult,
  AdapterSandboxCase,
  AdapterWriteContext,
  ServiceAdapter,
} from './integrations/service-adapter'
import type { EffectOutcome } from './effects/action-run'

export interface PersonalRecordsStore {
  listBills(): Promise<Array<{ id: string; name: string; amountTaka: number; dueDate: string; paid: boolean }>>
  listReminders(): Promise<Array<{ id: string; text: string; at: string; cancelled?: boolean }>>
  createReminder(input: { text: string; at: string }): Promise<{ id: string }>
  cancelReminder(id: string): Promise<boolean>
  getReminder(id: string): Promise<{ id: string; text: string; at: string; cancelled?: boolean } | null>
}

/** In-memory store — used by the sandbox suite and tests. */
export function makeMemoryPersonalStore(): PersonalRecordsStore {
  const bills: Array<{ id: string; name: string; amountTaka: number; dueDate: string; paid: boolean }> = [
    { id: 'b1', name: 'দোকান ভাড়া', amountTaka: 25000, dueDate: '2026-08-01', paid: false },
  ]
  const reminders = new Map<string, { id: string; text: string; at: string; cancelled?: boolean }>()
  let seq = 0
  return {
    listBills: async () => [...bills],
    listReminders: async () => [...reminders.values()],
    createReminder: async ({ text, at }) => {
      seq += 1
      const id = `r${seq}`
      reminders.set(id, { id, text, at })
      return { id }
    },
    cancelReminder: async (id) => {
      const r = reminders.get(id)
      if (!r || r.cancelled) return false
      r.cancelled = true
      return true
    },
    getReminder: async (id) => reminders.get(id) ?? null,
  }
}

/** Prisma-backed store (production). Lazily imported to keep tests DB-free. */
export function makePrismaPersonalStore(): PersonalRecordsStore {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const db = async (): Promise<any> => (await import('@/lib/prisma')).prisma as any
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return {
    listBills: async () => {
      const rows = await (await db()).agentBill.findMany({ orderBy: { dueDate: 'asc' }, take: 50 })
      return rows.map((b: { id: string; name: string; amount: number; dueDate: Date; status: string }) => ({
        id: b.id,
        name: b.name,
        amountTaka: Math.round(Number(b.amount ?? 0)),
        dueDate: b.dueDate?.toISOString?.().slice(0, 10) ?? '',
        paid: b.status === 'paid',
      }))
    },
    listReminders: async () => {
      const rows = await (await db()).agentReminder.findMany({ orderBy: { remindAt: 'asc' }, take: 50 })
      return rows.map((r: { id: string; message: string; remindAt: Date; status: string }) => ({
        id: r.id,
        text: r.message,
        at: r.remindAt?.toISOString?.() ?? '',
        cancelled: r.status === 'cancelled',
      }))
    },
    createReminder: async ({ text, at }) => {
      const row = await (await db()).agentReminder.create({ data: { message: text, remindAt: new Date(at), status: 'pending' }, select: { id: true } })
      return { id: row.id }
    },
    cancelReminder: async (id) => {
      const res = await (await db()).agentReminder.updateMany({ where: { id, status: { not: 'cancelled' } }, data: { status: 'cancelled' } })
      return res.count === 1
    },
    getReminder: async (id) => {
      const r = await (await db()).agentReminder.findUnique({ where: { id } })
      return r ? { id: r.id, text: r.message, at: r.remindAt?.toISOString?.() ?? '', cancelled: r.status === 'cancelled' } : null
    },
  }
}

const CAPABILITIES: AdapterCapability[] = [
  { op: 'list_bills', mode: 'read', risk: 'R0', labelBn: 'বিলের তালিকা দেখা', dataClass: 'personal', rateLimitPerMin: 30 },
  { op: 'list_reminders', mode: 'read', risk: 'R0', labelBn: 'রিমাইন্ডার দেখা', dataClass: 'personal', rateLimitPerMin: 30 },
  { op: 'draft_reminder', mode: 'stage', risk: 'R1', labelBn: 'রিমাইন্ডারের খসড়া বানানো', dataClass: 'personal', rateLimitPerMin: 20 },
  {
    op: 'create_reminder',
    mode: 'write',
    risk: 'R1',
    labelBn: 'রিমাইন্ডার তৈরি করা',
    dataClass: 'personal',
    rateLimitPerMin: 10,
    proof: 'record',
    undoOp: 'cancel_reminder',
    idempotency: 'engine',
  },
  {
    op: 'cancel_reminder',
    mode: 'write',
    risk: 'R1',
    labelBn: 'রিমাইন্ডার বাতিল করা',
    dataClass: 'personal',
    rateLimitPerMin: 10,
    proof: 'record',
    idempotency: 'engine',
  },
]

export function makePersonalRecordsAdapter(store: PersonalRecordsStore = makeMemoryPersonalStore()): ServiceAdapter {
  return {
    service: 'personal-records',
    scope: 'personal',
    capabilities: () => CAPABILITIES,

    health: async (): Promise<AdapterHealth> => {
      try {
        await store.listReminders()
        return { ok: true, detail: 'store reachable' }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    },

    read: async (op, _params): Promise<AdapterReadResult> => {
      if (op === 'list_bills') return { ok: true, data: await store.listBills() }
      if (op === 'list_reminders') return { ok: true, data: await store.listReminders() }
      return { ok: false, error: `unknown read op ${op}` }
    },

    stage: async (op, params): Promise<AdapterDraft> => {
      if (op !== 'draft_reminder') return { ok: false, error: `unknown stage op ${op}` }
      const text = String(params.text ?? '').trim()
      const at = String(params.at ?? '').trim()
      if (!text || !at) return { ok: false, error: 'text এবং at দুটোই লাগবে' }
      return { ok: true, draft: { kind: 'reminder_draft', text, at, note: 'খসড়া — অনুমোদনের আগে কিছুই সেট হয়নি' } }
    },

    write: async (op, params, ctx: AdapterWriteContext): Promise<EffectOutcome> => {
      if (op === 'create_reminder') {
        const text = String(params.text ?? '').trim()
        const at = String(params.at ?? '').trim()
        return ctx.runEffect({
          tool: 'personal_records.create_reminder',
          input: { text, at },
          riskTier: 'R1',
          execute: async () => {
            const { id } = await store.createReminder({ text, at })
            return { success: true, data: { id }, providerRef: id }
          },
          verify: async (result) => {
            const id = (result.data as { id?: string } | undefined)?.id
            if (!id) return null
            const found = await store.getReminder(id)
            return found && !found.cancelled ? { kind: 'record_reread', id } : null
          },
        })
      }
      if (op === 'cancel_reminder') {
        const id = String(params.id ?? '')
        return ctx.runEffect({
          tool: 'personal_records.cancel_reminder',
          input: { id },
          riskTier: 'R1',
          execute: async () => {
            const ok = await store.cancelReminder(id)
            return ok ? { success: true, data: { id } } : { success: false, error: 'reminder not found or already cancelled', retryable: false }
          },
          verify: async () => {
            const found = await store.getReminder(id)
            return found?.cancelled ? { kind: 'record_reread', id, cancelled: true } : null
          },
        })
      }
      return {
        ok: false,
        state: 'denied',
        runId: 'n/a',
        replayed: false,
        error: `unknown write op ${op}`,
        errorCode: 'effect_denied',
      }
    },

    sandboxCases: (): AdapterSandboxCase[] => [
      {
        name: 'reads work against the sandbox store',
        run: async (adapter) => {
          const bills = await adapter.read('list_bills', {})
          return { pass: bills.ok === true, detail: bills.error }
        },
      },
      {
        name: 'stage produces a private draft, no side effect',
        run: async (adapter) => {
          const before = await store.listReminders()
          const draft = await adapter.stage('draft_reminder', { text: 'কালকে ব্যাংকে যেতে হবে', at: '2026-07-18T10:00:00+06:00' })
          const after = await store.listReminders()
          return { pass: draft.ok && after.length === before.length, detail: draft.error }
        },
      },
      {
        name: 'unknown ops are refused',
        run: async (adapter) => {
          const res = await adapter.read('drop_everything', {})
          return { pass: res.ok === false }
        },
      },
    ],

    disconnect: async () => {
      /* in-house store — nothing to revoke; syncs would stop here */
    },
  }
}
