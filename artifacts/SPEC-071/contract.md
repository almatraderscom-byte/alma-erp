# SPEC-071 — Contract

## Public types (typed + runtime-validated)

`inventory.schema.ts` (zod + TS):

```ts
INVENTORY_MODES = ['read','stage','write']
INVENTORY_RISKS = ['low','medium','high']
inventoryRowSchema = z.object({
  name: string(min 1),
  domain: string|null, mode: enum|null, risk: enum|null,
  groups: string[], pools: string[], hasSchema: boolean,
})
type InventoryRow = z.infer<...>
parseInventoryRows(unknown): InventoryRow[]   // throws on first bad row
```

## Boundary contract (G01 `@/agent/contracts`)

`inventory.ts` exposes an identity-enforced boundary returning the frozen
`ComponentResult<T>` discriminated union — never a bare boolean, never a throw:

```ts
INVENTORY_CONTRACT_VERSION = '1.0.0'   // === COMPONENT_CONTRACT_VERSION

type InventoryQuery =
  | { kind:'get'; name:string }
  | { kind:'byDomain'; domain:string }
  | { kind:'byMode'; mode:InventoryMode }
  | { kind:'byRisk'; risk:InventoryRisk }
  | { kind:'byGroup'; group:string }
  | { kind:'byPool'; pool:string }
  | { kind:'summary' }

queryInventory(raw: unknown): ComponentResult<InventoryResultValue>
```

`queryInventory` runs `validateRequest()` (G01) first: identity present, contract
version matches, payload within 256 KiB. On failure it returns
`failure('FAILED_FINAL', reasonCodes)` with finite reason codes
(`MISSING_TENANT`, `MISSING_ACTOR`, `CONTRACT_VERSION_MISMATCH`,
`MALFORMED_INPUT`, …). On success `completed(value, [], { inventory: version })`.

## Plain helpers (tests / internal)

`getTool`, `hasTool`, `allToolNames`, `toolsByDomain`, `toolsByMode`,
`toolsByRisk`, `toolsByGroup`, `toolsByPool`, `distinctDomains`, `summarize`.

## Reason codes

Reuses the frozen G01 `REASON_CODES` set — no new codes minted here.

## Audit / metrics fields

Results carry `versions` and (empty) `evidenceIds`, matching `ComponentSuccess`.
The read-only inventory emits no audit side effect; downstream boundaries that
consume it stamp their own `AuditEvent`.
