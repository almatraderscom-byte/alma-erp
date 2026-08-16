/**
 * G08 / SPEC-071 — Inventory drift guard.
 *
 * THE RULE: every tool registered in the live monolith (registry.ts pools +
 * capability-classification) MUST appear in the committed G08 snapshot
 * (inventory.data.ts) and its downstream generated files. The snapshot is a
 * mirror of the live surface, NOT a frozen point-in-time — a tool missing from
 * it is invisible to G09 retrieval (`retrieveForIntent`), the capability
 * broker, `isRetrievableTool`, arg-validation and the schema-minimizer, even
 * though `find_tool` (which searches the live registry) can still see it.
 *
 * Between 2026-07-22 and 2026-08-14 the snapshot silently rotted 327 → 355
 * because nothing compared it to the monolith. This test closes that gap.
 *
 * When this test fails you added/removed a tool without regenerating. Run, in
 * this order (io-schemas reads the manifests, so it goes after them):
 *   npx tsx --tsconfig tsconfig.json src/agent/tools/registry/scripts/build-inventory.ts
 *   npx tsx --tsconfig tsconfig.json src/agent/tools/manifests/scripts/build-domain-manifests.ts
 *   npx tsx --tsconfig tsconfig.json src/agent/capabilities/scripts/build-catalog.ts
 *   npx tsx --tsconfig tsconfig.json src/agent/tools/registry/scripts/build-io-schemas.ts
 * then update the count pins in:
 *   registry/__tests__/{inventory,io-schema,runtime-registry,ownership-metadata}.test.ts
 *   manifests/__tests__/domain-package.test.ts
 *   capabilities/__tests__/{capability-model,tool-map}.test.ts
 *
 * The imports below are the same dev-time monolith reads build-inventory.ts
 * does; the runtime registry itself stays monolith-free (INV-01) — tests are
 * exempt from that invariant.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_CLASSIFICATION } from '@/agent/tools/capability-classification'
import { TOOL_GROUPS } from '@/agent/tools/tool-groups'
import {
  TOOLS,
  TRADING_TOOLS,
  PERSONAL_SAFE_TOOLS,
  STAFF_SAFE_TOOLS,
  type AgentTool,
} from '@/agent/tools/registry'
import { CUSTOMER_SAFE_TOOLS } from '@/agent/tools/cs-registry'
import { INVENTORY_ROWS } from '../inventory.data'

/** Rebuild the rows exactly the way build-inventory.ts collect() does. */
function liveRows(): Map<string, string> {
  const groupOf: Record<string, string[]> = {}
  for (const [g, tools] of Object.entries(TOOL_GROUPS)) {
    for (const t of tools as AgentTool[]) (groupOf[t.name] ??= []).push(g)
  }

  const poolSources: Array<[string, readonly AgentTool[]]> = [
    ['lifestyle', TOOLS],
    ['trading', TRADING_TOOLS],
    ['personal', PERSONAL_SAFE_TOOLS],
    ['staff', STAFF_SAFE_TOOLS],
    ['customer', CUSTOMER_SAFE_TOOLS],
  ]
  const poolOf: Record<string, string[]> = {}
  const schemaOf: Record<string, boolean> = {}
  for (const [p, tools] of poolSources) {
    for (const t of tools) {
      ;(poolOf[t.name] ??= []).push(p)
      const props = (t.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties
      schemaOf[t.name] = schemaOf[t.name] || Object.keys(props ?? {}).length > 0
    }
  }

  const names = new Set<string>([...Object.keys(TOOL_CLASSIFICATION), ...Object.keys(poolOf)])
  const rows = new Map<string, string>()
  for (const name of [...names].sort()) {
    const c = TOOL_CLASSIFICATION[name]
    rows.set(
      name,
      JSON.stringify({
        name,
        domain: c?.domain ?? null,
        mode: c?.mode ?? null,
        risk: c?.risk ?? null,
        groups: (groupOf[name] ?? []).slice().sort(),
        pools: (poolOf[name] ?? []).slice().sort(),
        hasSchema: schemaOf[name] ?? false,
      }),
    )
  }
  return rows
}

describe('SPEC-071 inventory drift guard (live monolith vs committed snapshot)', () => {
  it('the snapshot matches the live surface row-for-row (names AND metadata)', () => {
    const live = liveRows()
    const snapshot = new Map(INVENTORY_ROWS.map((r) => [r.name, JSON.stringify(r)]))

    const missing = [...live.keys()].filter((n) => !snapshot.has(n)).sort()
    const ghosts = [...snapshot.keys()].filter((n) => !live.has(n)).sort()
    expect(missing, 'live tools missing from inventory.data.ts — regenerate (see file header)').toEqual([])
    expect(ghosts, 'snapshot rows no longer in the monolith — regenerate (see file header)').toEqual([])

    // Metadata drift (domain/mode/risk/groups/pools/hasSchema changed without
    // regen) leaves the G08/G09 path routing on stale policy — catch it too.
    const stale = [...live.entries()]
      .filter(([n, row]) => snapshot.get(n) !== row)
      .map(([n, row]) => ({ name: n, live: JSON.parse(row), snapshot: JSON.parse(snapshot.get(n)!) }))
    expect(stale, 'snapshot metadata differs from the live monolith — regenerate (see file header)').toEqual([])
  })
})
