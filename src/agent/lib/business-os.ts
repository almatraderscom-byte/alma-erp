/**
 * Phase 56 — BUSINESS OS: the first business service adapter ('erp-orders':
 * order overview, private customer-update drafts, and internal order notes).
 *
 * Same contract as the personal adapter: reads free, stages private, writes
 * guarded + exactly-once + verified + undoable. The customer-update op only
 * DRAFTS a message — sending stays with the R3 point-of-risk flow (Phase 57
 * ladder), which is exactly the roadmap's "private draft/sandbox only" gate.
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

export interface OrdersStore {
  orderSummary(): Promise<{ open: number; packed: number; deliveredToday: number }>
  getOrder(orderId: string): Promise<{ id: string; customerName: string; status: string } | null>
  addOrderNote(orderId: string, note: string): Promise<{ noteId: string }>
  getOrderNote(noteId: string): Promise<{ noteId: string; orderId: string; note: string; removed?: boolean } | null>
  removeOrderNote(noteId: string): Promise<boolean>
}

/** In-memory store for sandbox/tests. */
export function makeMemoryOrdersStore(): OrdersStore {
  const orders = new Map([
    ['o1', { id: 'o1', customerName: 'Customer A', status: 'processing' }],
    ['o2', { id: 'o2', customerName: 'Customer B', status: 'shipped' }],
  ])
  const notes = new Map<string, { noteId: string; orderId: string; note: string; removed?: boolean }>()
  let seq = 0
  return {
    orderSummary: async () => ({ open: 2, packed: 1, deliveredToday: 4 }),
    getOrder: async (id) => orders.get(id) ?? null,
    addOrderNote: async (orderId, note) => {
      if (!orders.has(orderId)) throw new Error(`order ${orderId} not found`)
      seq += 1
      const noteId = `n${seq}`
      notes.set(noteId, { noteId, orderId, note })
      return { noteId }
    },
    getOrderNote: async (noteId) => notes.get(noteId) ?? null,
    removeOrderNote: async (noteId) => {
      const n = notes.get(noteId)
      if (!n || n.removed) return false
      n.removed = true
      return true
    },
  }
}

const CAPABILITIES: AdapterCapability[] = [
  { op: 'order_summary', mode: 'read', risk: 'R0', labelBn: 'অর্ডারের সারসংক্ষেপ', dataClass: 'business_internal', rateLimitPerMin: 30 },
  { op: 'get_order', mode: 'read', risk: 'R0', labelBn: 'একটা অর্ডার দেখা', dataClass: 'customer_pii', rateLimitPerMin: 30 },
  { op: 'draft_customer_update', mode: 'stage', risk: 'R1', labelBn: 'কাস্টমার আপডেটের খসড়া', dataClass: 'customer_pii', rateLimitPerMin: 20 },
  {
    op: 'add_order_note',
    mode: 'write',
    risk: 'R1',
    labelBn: 'অর্ডারে ইন্টারনাল নোট যোগ',
    dataClass: 'business_internal',
    rateLimitPerMin: 15,
    proof: 'record',
    undoOp: 'remove_order_note',
    idempotency: 'engine',
  },
  {
    op: 'remove_order_note',
    mode: 'write',
    risk: 'R1',
    labelBn: 'অর্ডার নোট মুছে ফেলা',
    dataClass: 'business_internal',
    rateLimitPerMin: 15,
    proof: 'record',
    idempotency: 'engine',
  },
]

export function makeErpOrdersAdapter(store: OrdersStore = makeMemoryOrdersStore()): ServiceAdapter {
  return {
    service: 'erp-orders',
    scope: 'business',
    capabilities: () => CAPABILITIES,

    health: async (): Promise<AdapterHealth> => {
      try {
        await store.orderSummary()
        return { ok: true, detail: 'orders store reachable' }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    },

    read: async (op, params): Promise<AdapterReadResult> => {
      if (op === 'order_summary') return { ok: true, data: await store.orderSummary() }
      if (op === 'get_order') {
        const order = await store.getOrder(String(params.orderId ?? ''))
        return order ? { ok: true, data: order } : { ok: false, error: 'order not found' }
      }
      return { ok: false, error: `unknown read op ${op}` }
    },

    stage: async (op, params): Promise<AdapterDraft> => {
      if (op !== 'draft_customer_update') return { ok: false, error: `unknown stage op ${op}` }
      const orderId = String(params.orderId ?? '')
      const order = await store.getOrder(orderId)
      if (!order) return { ok: false, error: 'order not found' }
      return {
        ok: true,
        draft: {
          kind: 'customer_update_draft',
          orderId,
          messageBn: `আসসালামু আলাইকুম! আপনার অর্ডার (${orderId}) এখন "${order.status}" অবস্থায় আছে।`,
          note: 'খসড়া — পাঠানো হয়নি; পাঠানো R3 point-of-risk অনুমোদনের কাজ',
        },
      }
    },

    write: async (op, params, ctx: AdapterWriteContext): Promise<EffectOutcome> => {
      if (op === 'add_order_note') {
        const orderId = String(params.orderId ?? '')
        const note = String(params.note ?? '').trim()
        return ctx.runEffect({
          tool: 'erp_orders.add_order_note',
          input: { orderId, note },
          riskTier: 'R1',
          execute: async () => {
            const { noteId } = await store.addOrderNote(orderId, note)
            return { success: true, data: { noteId }, providerRef: noteId }
          },
          verify: async (result) => {
            const noteId = (result.data as { noteId?: string } | undefined)?.noteId
            if (!noteId) return null
            const found = await store.getOrderNote(noteId)
            return found && !found.removed ? { kind: 'record_reread', noteId } : null
          },
        })
      }
      if (op === 'remove_order_note') {
        const noteId = String(params.noteId ?? '')
        return ctx.runEffect({
          tool: 'erp_orders.remove_order_note',
          input: { noteId },
          riskTier: 'R1',
          execute: async () => {
            const ok = await store.removeOrderNote(noteId)
            return ok ? { success: true, data: { noteId } } : { success: false, error: 'note not found or already removed', retryable: false }
          },
          verify: async () => {
            const found = await store.getOrderNote(noteId)
            return found?.removed ? { kind: 'record_reread', noteId, removed: true } : null
          },
        })
      }
      return { ok: false, state: 'denied', runId: 'n/a', replayed: false, error: `unknown write op ${op}`, errorCode: 'effect_denied' }
    },

    sandboxCases: (): AdapterSandboxCase[] => [
      {
        name: 'summary + single-order reads work',
        run: async (adapter) => {
          const s = await adapter.read('order_summary', {})
          const o = await adapter.read('get_order', { orderId: 'o1' })
          return { pass: s.ok && o.ok }
        },
      },
      {
        name: 'customer update stays a DRAFT (no send path exists here)',
        run: async (adapter) => {
          const d = await adapter.stage('draft_customer_update', { orderId: 'o1' })
          const draft = d.draft as { kind?: string } | undefined
          return { pass: d.ok && draft?.kind === 'customer_update_draft', detail: d.error }
        },
      },
      {
        name: 'missing order fails clean',
        run: async (adapter) => {
          const d = await adapter.stage('draft_customer_update', { orderId: 'nope' })
          return { pass: d.ok === false }
        },
      },
    ],

    disconnect: async () => {
      /* in-house ERP — nothing external to revoke */
    },
  }
}
