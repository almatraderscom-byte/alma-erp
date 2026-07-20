# SPEC-072 — Architecture scan

Imports in owned zone: `@/agent/contracts`, `zod`, relative only.
```
$ grep -rnE "anthropic|openai|gemini|fetch\(|axios|prisma|@/lib/|process.env" \
    src/agent/tools/manifests/*.ts | grep -v node:
# only doc-comment mentions of the words prisma/model — no call sites
```
INV-01 holds (pure types + zod). No monolith import. No ERP→agent import (files
are agent-side). Ownership-zone diff: only `src/agent/tools/manifests/` +
`artifacts/SPEC-072/`. PASS.
