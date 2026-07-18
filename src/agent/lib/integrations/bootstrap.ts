/**
 * Phase 66 — service-adapter BOOTSTRAP (closes GAP-06's "registerServiceAdapter
 * has no production caller").
 *
 * Registers the internal OS adapters exactly once per process. Idempotent (a
 * module flag + the registry's own Map), so repeated calls — e.g. lazily from
 * getServiceAdapter on each serverless cold start — register nothing twice.
 *
 * PRODUCTION CONSTRUCTORS MUST USE REAL STORES. In-memory stores are test/
 * sandbox only and are impossible in production: in a production environment
 * `personal-records` is built on the Prisma store, and `erp-orders` is NOT
 * registered until its Prisma store lands + is DB-verified (registering the
 * in-memory one in prod would be a silent fake — we refuse it).
 */
import { registerServiceAdapter, getServiceAdapter } from './service-registry'

let bootstrapped = false

function isProduction(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

export interface BootstrapResult {
  registered: string[]
  skipped: Array<{ service: string; reason: string }>
}

/**
 * Register the internal OS adapters. `allowMemory` forces the in-memory stores
 * (tests/sandbox); it is IGNORED in production (memory can never run in prod).
 */
export async function bootstrapServiceAdapters(opts: { allowMemory?: boolean } = {}): Promise<BootstrapResult> {
  const prod = isProduction()
  const allowMemory = prod ? false : (opts.allowMemory ?? true)
  const registered: string[] = []
  const skipped: Array<{ service: string; reason: string }> = []

  // personal-records — real Prisma store in production; memory only in dev/test.
  try {
    if (!getServiceAdapter('personal-records')) {
      const { makePersonalRecordsAdapter, makePrismaPersonalStore, makeMemoryPersonalStore } = await import('@/agent/lib/personal-os')
      const store = allowMemory ? makeMemoryPersonalStore() : makePrismaPersonalStore()
      registerServiceAdapter(makePersonalRecordsAdapter(store))
      registered.push('personal-records')
    }
  } catch (err) {
    skipped.push({ service: 'personal-records', reason: err instanceof Error ? err.message : String(err) })
  }

  // erp-orders — only a memory store exists today. In production we REFUSE to
  // register a fake in-memory ERP adapter; it waits for a Prisma orders store.
  try {
    if (!getServiceAdapter('erp-orders')) {
      if (allowMemory) {
        const { makeErpOrdersAdapter } = await import('@/agent/lib/business-os')
        registerServiceAdapter(makeErpOrdersAdapter())
        registered.push('erp-orders')
      } else {
        skipped.push({ service: 'erp-orders', reason: 'no Prisma orders store yet — refusing in-memory in production' })
      }
    }
  } catch (err) {
    skipped.push({ service: 'erp-orders', reason: err instanceof Error ? err.message : String(err) })
  }

  return { registered, skipped }
}

/** Idempotent lazy bootstrap — safe to call on every request/cold start. */
export async function ensureServiceAdaptersBootstrapped(opts: { allowMemory?: boolean } = {}): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true
  await bootstrapServiceAdapters(opts)
}

/** Test hook — allows re-bootstrap in a fresh registry. */
export function resetBootstrapFlag(): void {
  bootstrapped = false
}
