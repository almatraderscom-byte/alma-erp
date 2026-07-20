# SPEC-082 — Baseline (capability-to-intent mapping)
Parent: SPEC-081 (`d8214b33`). Owned zones: capabilities, prisma/agent-capability.

Today intent lives only at G02 admission as a coarse class
(command/question/task/chitchat/unknown) — there is NO index from a business
intent to the capabilities that serve it, and no consistency between a
capability's business intents and the admission class it applies to.

Discovery:
```
$ grep -n "INTENT_CLASSES" src/agent/control-plane/admission/intent.ts
$ grep -rn "capabilitiesForIntent\|byIntent" src/agent/capabilities  # none before this spec
```
Migration boundary: two indexes (intent key → caps, IntentClass → caps) + a
consistency checker, over the SPEC-081 catalog.
Files: intent-map.ts, tests, index.ts update.
