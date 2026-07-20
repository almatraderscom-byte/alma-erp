/**
 * G08 / SPEC-071 — Current monolithic registry inventory (runtime API).
 *
 * The decomposed registry's first boundary: a typed, validated, queryable view
 * of the monolithic tool surface, decoupled from the monolith itself. It reads
 * ONLY the committed `inventory.data.ts` snapshot — never the live registry —
 * so it is deterministic, cheap and free of prisma/network/model dependencies
 * (INV-01).
 *
 * Two access styles:
 *  - Plain helpers (`getTool`, `toolsByDomain`, …) for tests and internal use.
 *  - A `ComponentRequest`/`ComponentResult` boundary (`queryInventory`) that
 *    enforces the canonical ExecutionIdentity (INV-02) and returns the frozen
 *    G01 discriminated union — never an ambiguous boolean or a thrown value.
 */
import {
  type ComponentRequest,
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'
import {
  INVENTORY_GROUPS,
  INVENTORY_POOLS,
  INVENTORY_ROWS,
  INVENTORY_SOURCE,
} from './inventory.data'
import {
  type InventoryMode,
  type InventoryRisk,
  type InventoryRow,
  parseInventoryRows,
} from './inventory.schema'

/** Contract version stamped onto inventory results. */
export const INVENTORY_CONTRACT_VERSION = '1.0.0' as const

/**
 * The validated inventory. Parsing at module load turns a corrupt snapshot into
 * a loud failure instead of silent downstream skew.
 */
export const TOOL_INVENTORY: readonly InventoryRow[] = Object.freeze(
  parseInventoryRows(INVENTORY_ROWS as unknown),
)

const BY_NAME: ReadonlyMap<string, InventoryRow> = new Map(
  TOOL_INVENTORY.map((r) => [r.name, r]),
)

export const INVENTORY_META = Object.freeze({
  source: INVENTORY_SOURCE,
  groups: INVENTORY_GROUPS,
  pools: INVENTORY_POOLS,
  total: TOOL_INVENTORY.length,
})

// ── Plain query helpers ─────────────────────────────────────────────────────

export function getTool(name: string): InventoryRow | undefined {
  return BY_NAME.get(name)
}

export function hasTool(name: string): boolean {
  return BY_NAME.has(name)
}

export function allToolNames(): string[] {
  return TOOL_INVENTORY.map((r) => r.name)
}

export function toolsByDomain(domain: string): InventoryRow[] {
  return TOOL_INVENTORY.filter((r) => r.domain === domain)
}

export function toolsByMode(mode: InventoryMode): InventoryRow[] {
  return TOOL_INVENTORY.filter((r) => r.mode === mode)
}

export function toolsByRisk(risk: InventoryRisk): InventoryRow[] {
  return TOOL_INVENTORY.filter((r) => r.risk === risk)
}

export function toolsByGroup(group: string): InventoryRow[] {
  return TOOL_INVENTORY.filter((r) => r.groups.includes(group))
}

export function toolsByPool(pool: string): InventoryRow[] {
  return TOOL_INVENTORY.filter((r) => r.pools.includes(pool))
}

export function distinctDomains(): string[] {
  return [...new Set(TOOL_INVENTORY.map((r) => r.domain).filter((d): d is string => d !== null))].sort()
}

export interface InventorySummary {
  total: number
  byMode: Record<string, number>
  byRisk: Record<string, number>
  byDomain: Record<string, number>
  unclassified: string[]
  ungrouped: string[]
  unpooled: string[]
}

/** Deterministic roll-up used by the baseline proof and the removal gate. */
export function summarize(): InventorySummary {
  const byMode: Record<string, number> = {}
  const byRisk: Record<string, number> = {}
  const byDomain: Record<string, number> = {}
  const unclassified: string[] = []
  const ungrouped: string[] = []
  const unpooled: string[] = []
  for (const r of TOOL_INVENTORY) {
    if (r.mode) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1
    if (r.risk) byRisk[r.risk] = (byRisk[r.risk] ?? 0) + 1
    if (r.domain) byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1
    else unclassified.push(r.name)
    if (r.groups.length === 0) ungrouped.push(r.name)
    if (r.pools.length === 0) unpooled.push(r.name)
  }
  return { total: TOOL_INVENTORY.length, byMode, byRisk, byDomain, unclassified, ungrouped, unpooled }
}

// ── Boundary contract (identity-enforced) ───────────────────────────────────

export type InventoryQuery =
  | { kind: 'get'; name: string }
  | { kind: 'byDomain'; domain: string }
  | { kind: 'byMode'; mode: InventoryMode }
  | { kind: 'byRisk'; risk: InventoryRisk }
  | { kind: 'byGroup'; group: string }
  | { kind: 'byPool'; pool: string }
  | { kind: 'summary' }

const inventoryQuerySchema: z.ZodType<InventoryQuery> = z.union([
  z.object({ kind: z.literal('get'), name: z.string().min(1) }),
  z.object({ kind: z.literal('byDomain'), domain: z.string().min(1) }),
  z.object({ kind: z.literal('byMode'), mode: z.enum(['read', 'stage', 'write']) }),
  z.object({ kind: z.literal('byRisk'), risk: z.enum(['low', 'medium', 'high']) }),
  z.object({ kind: z.literal('byGroup'), group: z.string().min(1) }),
  z.object({ kind: z.literal('byPool'), pool: z.string().min(1) }),
  z.object({ kind: z.literal('summary') }),
])

export type InventoryResultValue =
  | { kind: 'get'; row: InventoryRow | null }
  | { kind: 'list'; rows: InventoryRow[] }
  | { kind: 'summary'; summary: InventorySummary }

/**
 * Identity-enforced inventory query. Rejects malformed input and missing
 * identity fields (MISSING_TENANT / MISSING_ACTOR / …) fail-closed, never
 * throwing across the boundary. Read-only: it performs no side effect, so it
 * needs no Cost Governor / Tool Gateway authorization.
 */
export function queryInventory(raw: unknown): ComponentResult<InventoryResultValue> {
  const check = validateRequest(raw, inventoryQuerySchema, INVENTORY_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const req: ComponentRequest<InventoryQuery> = check.request
  const q = req.payload

  const versions = { inventory: INVENTORY_CONTRACT_VERSION }
  switch (q.kind) {
    case 'get':
      return completed({ kind: 'get', row: getTool(q.name) ?? null }, [], versions)
    case 'byDomain':
      return completed({ kind: 'list', rows: toolsByDomain(q.domain) }, [], versions)
    case 'byMode':
      return completed({ kind: 'list', rows: toolsByMode(q.mode) }, [], versions)
    case 'byRisk':
      return completed({ kind: 'list', rows: toolsByRisk(q.risk) }, [], versions)
    case 'byGroup':
      return completed({ kind: 'list', rows: toolsByGroup(q.group) }, [], versions)
    case 'byPool':
      return completed({ kind: 'list', rows: toolsByPool(q.pool) }, [], versions)
    case 'summary':
      return completed({ kind: 'summary', summary: summarize() }, [], versions)
    default:
      return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  }
}
