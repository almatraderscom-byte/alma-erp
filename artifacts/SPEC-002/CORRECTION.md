# SPEC-002 Correction — forbidden-import gate coverage (Vercel review)

**Finding (vercel[bot] on PR #484):** the gate's `IMPORT_RE` did not match bare
side-effect imports — `import '@/agent/foo';` — so ERP/shared code could
side-effect-import the agent module and never be flagged. Confirmed by probe:
the old gate returned PASS on `import '@/agent/config'` from `src/app`.

**Fix:**
1. `IMPORT_RE` now also matches bare `import '...'` (third alternative), and the
   scanner reads capture group m[3].
2. Added `resolveSpec()` so relative imports (`../agent/x`, `./agent/x`) resolve
   to the same zone as `@/agent/x` — previously only alias/`src/`-prefixed specs
   were classified.

**Re-verification:** probe `import '@/agent/config'` from `src/app` now returns
`FAIL — 1 NEW forbidden import`. Clean run still PASS at 101 baselined (the
improved regex revealed no hidden pre-existing violations, so no re-baseline
needed). See `evidence/vercel-fix.txt`.
