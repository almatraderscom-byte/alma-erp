# SPEC-020 Architecture Scan — Admission bypass CI gate

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg -n "control-plane" src/app src/lib   (ERP must NOT import agent control-plane)
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
# admission code must be deterministic — no direct provider/model/db call:
$ rg -n "fetch\(|googleapis|openrouter|anthropic|@prisma/client|\$queryRaw" src/agent/control-plane
  NONE — admission plane is deterministic (INV-01); model calls happen later via Cost Governor
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-020`.
See `changed-files.md`.

## Executable gate

```text
$ node src/agent/control-plane/admission/check-admission-bypass.mjs
admission bypass gate: 2013 files scanned
PASS — no code bypasses the admission gateway (public entrypoints only)
exit=0

# ratchet proof: inject outsider importing internal module
FAIL — 1 bypass(es):
  src/agent/__probe.ts -> @/agent/control-plane/admission/normalize (internal: normalize)
# removed -> PASS
PASS — no code bypasses the admission gateway (public entrypoints only)
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

