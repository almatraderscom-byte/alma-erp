# SPEC-083 — Baseline (capability-to-tool mapping)
Parent: SPEC-082 (`82115fad`). Owned zones: capabilities, prisma/agent-capability.

The SPEC-081 catalog lists `toolNames` per capability but nothing validates them
against the real G08 manifest set, and nothing proves the capabilities COVER the
tool surface. G08 has `getManifest`/`ALL_MANIFESTS` (decoupled loader).

Discovery:
```
$ grep -n "getManifest\|ALL_MANIFESTS" src/agent/tools/manifests/loader.ts
$ grep -rn "toolsForCapability\|coverage" src/agent/capabilities  # none before this spec
```
Migration boundary: forward + reverse tool index validated against G08, with a
coverage/partition check.
Files: tool-map.ts, tests, index.ts update.
