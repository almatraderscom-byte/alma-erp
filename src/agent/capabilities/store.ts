/**
 * G09 / SPEC-081 — Capability store interface + in-memory default.
 *
 * The durable capability catalog will eventually live in Postgres (see the
 * PROPOSED, NOT-APPLIED migration `prisma/agent-capability/0001_*.sql`). To keep
 * G09 deterministic and free of any live-DB dependency (INV-01, and the standing
 * "do not touch live prisma" decision), the runtime speaks to a typed
 * `CapabilityStore` INTERFACE and ships an in-memory default seeded from the
 * generated catalog. A Postgres-backed store can implement the same interface
 * later without changing a single consumer.
 *
 * Reads only: the store is a catalog, not a mutation surface. All data is
 * validated on construction so a corrupt catalog fails loud.
 */
import { capabilitySchema, type Capability } from './capability.schema'
import { CAPABILITY_CATALOG } from './catalog.generated'

export interface CapabilityStore {
  get(id: string): Capability | undefined
  getByKey(key: string): Capability | undefined
  list(): readonly Capability[]
  keys(): string[]
}

/** Deterministic in-memory store. Validates every capability on construction. */
export class InMemoryCapabilityStore implements CapabilityStore {
  private readonly byId: ReadonlyMap<string, Capability>
  private readonly byKey: ReadonlyMap<string, Capability>
  private readonly all: readonly Capability[]

  constructor(catalog: readonly unknown[]) {
    const parsed = catalog.map((c) => capabilitySchema.parse(c))
    parsed.sort((a, b) => a.key.localeCompare(b.key))
    const byId = new Map<string, Capability>()
    const byKey = new Map<string, Capability>()
    for (const c of parsed) {
      if (byId.has(c.id)) throw new Error(`duplicate capability id: ${c.id}`)
      if (byKey.has(c.key)) throw new Error(`duplicate capability key: ${c.key}`)
      byId.set(c.id, c)
      byKey.set(c.key, c)
    }
    this.byId = byId
    this.byKey = byKey
    this.all = parsed
  }

  get(id: string): Capability | undefined {
    return this.byId.get(id)
  }
  getByKey(key: string): Capability | undefined {
    return this.byKey.get(key)
  }
  list(): readonly Capability[] {
    return this.all
  }
  keys(): string[] {
    return this.all.map((c) => c.key)
  }
}

/** The default catalog-backed store used across G09. */
export const capabilityStore: CapabilityStore = new InMemoryCapabilityStore(CAPABILITY_CATALOG)

/** Convenience: the full validated catalog. */
export const CAPABILITIES: readonly Capability[] = capabilityStore.list()
