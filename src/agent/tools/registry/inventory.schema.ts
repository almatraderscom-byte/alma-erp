/**
 * G08 / SPEC-071 — Inventory row schema.
 *
 * Runtime (zod) + compile-time (TS) contract for one row of the monolith
 * inventory snapshot. Deterministic, no I/O, no LLM. The generated
 * `inventory.data.ts` is validated against this at module load so a corrupt or
 * hand-edited snapshot fails loud instead of silently skewing every downstream
 * consumer (risk classification, ownership, the removal gate).
 */
import { z } from 'zod'

/** Capability mode as authored in the monolith (mirrors tool-contract CapabilityMode). */
export const INVENTORY_MODES = ['read', 'stage', 'write'] as const
export type InventoryMode = (typeof INVENTORY_MODES)[number]

/** Risk class as authored in the monolith. */
export const INVENTORY_RISKS = ['low', 'medium', 'high'] as const
export type InventoryRisk = (typeof INVENTORY_RISKS)[number]

export const inventoryRowSchema = z.object({
  /** Stable tool name (the identifier the head calls). */
  name: z.string().min(1),
  /** Authored business domain, or null if the tool has no classification entry. */
  domain: z.string().min(1).nullable(),
  /** Authored capability mode, or null if unclassified. */
  mode: z.enum(INVENTORY_MODES).nullable(),
  /** Authored risk class, or null if unclassified. */
  risk: z.enum(INVENTORY_RISKS).nullable(),
  /** TOOL_GROUPS entries advertising this tool to a head (sorted, may be empty). */
  groups: z.array(z.string().min(1)),
  /** Execution pools the tool is registered in (sorted, may be empty). */
  pools: z.array(z.string().min(1)),
  /** Whether the tool declares at least one input property. */
  hasSchema: z.boolean(),
})

export type InventoryRow = z.infer<typeof inventoryRowSchema>

export const inventoryRowsSchema = z.array(inventoryRowSchema)

/** Validate a snapshot array, throwing a precise error on the first bad row. */
export function parseInventoryRows(rows: unknown): InventoryRow[] {
  return inventoryRowsSchema.parse(rows)
}
