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
import {
  TOOLS,
  TRADING_TOOLS,
  PERSONAL_SAFE_TOOLS,
  STAFF_SAFE_TOOLS,
} from '@/agent/tools/registry'
import { CUSTOMER_SAFE_TOOLS } from '@/agent/tools/cs-registry'
import { INVENTORY_ROWS } from '../inventory.data'

function liveNames(): Set<string> {
  const names = new Set<string>(Object.keys(TOOL_CLASSIFICATION))
  for (const pool of [TOOLS, TRADING_TOOLS, PERSONAL_SAFE_TOOLS, STAFF_SAFE_TOOLS, CUSTOMER_SAFE_TOOLS]) {
    for (const t of pool) names.add(t.name)
  }
  return names
}

describe('SPEC-071 inventory drift guard (live monolith vs committed snapshot)', () => {
  it('the snapshot covers every live tool and carries no ghosts', () => {
    const live = liveNames()
    const snapshot = new Set(INVENTORY_ROWS.map((r) => r.name))
    const missing = [...live].filter((n) => !snapshot.has(n)).sort()
    const ghosts = [...snapshot].filter((n) => !live.has(n)).sort()
    expect(missing, 'live tools missing from inventory.data.ts — regenerate (see file header)').toEqual([])
    expect(ghosts, 'snapshot rows no longer in the monolith — regenerate (see file header)').toEqual([])
  })
})
