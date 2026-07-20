# SPEC-073 — Architecture scan
Runtime files (loader, domain-package, derive-side-effects, domains.generated)
import the monolith: NONE. The generator imports ONLY the committed inventory
snapshot (`registry/inventory.data.ts` + its schema) — zero monolith coupling.
```
$ grep -rnE "from '@/agent/tools/(registry'|tool-groups|capability|cs-registry)" \
    manifests/{loader,domain-package,derive-side-effects,domains.generated}.ts
NONE
```
INV-01 holds (pure data + zod). No ERP→agent import. Ownership diff: only
`src/agent/tools/manifests/` + `artifacts/SPEC-073/`. PASS.
