# SPEC-081 — Contract

`capability.schema.ts` (zod + TS), contract version 1.0.0.

## Capability envelope
```
id            cap.<snake_case>  (== cap.<key>)
key           snake_case domain key
title, description, status(active|preview|disabled)
intents       string[] (>=1)               business-intent keys (SPEC-082 logic)
intentClasses G02 IntentClass[] (>=1)       admission classes (SPEC-082)
toolNames     string[] (>=1, unique)        G08 tools (SPEC-083 validates)
permission    { scope, minRole: owner|staff|customer, defaultDecision: 'deny' }  (SPEC-084)
cost          { tier: light|standard|heavy, class: free|metered|premium }        (SPEC-085)
runtime       { groups[], pools[] }         (SPEC-086)
owner         { team, zonePrefix }          (SPEC-086)
health        { status: healthy|degraded|disabled, killSwitch, reason? }         (SPEC-087)
```
Cross-field: id == cap.<key>; disabled ⇒ health.status disabled; unique toolNames.

## Store (store.ts)
`CapabilityStore` interface (get/getByKey/list/keys). `InMemoryCapabilityStore`
validates every capability on construction; throws on duplicate id/key or invalid
data (fail-closed). `capabilityStore` default seeded from the generated 63-capability
catalog.

## Boundary (capability-model.ts), v1.0.0
`queryCapabilities(raw): ComponentResult<CapabilityResultValue>` — get|getByKey|
list|count; identity-enforced; never throws.

## Durable store
PROPOSED (not-applied) `prisma/agent-capability/0001_capability_catalog.proposed.sql`
— additive, reversible; NOT wired into the live migration system.
