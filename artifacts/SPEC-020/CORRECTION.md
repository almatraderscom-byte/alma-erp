# SPEC-020 Correction — bypass gate coverage (Vercel review)

**Finding (vercel[bot] on PR #484):** the admission bypass gate matched only
alias/absolute specs (`agent/control-plane/admission/x`). Relative-path imports
of internal stage modules — e.g. `./admission/normalize` from a control-plane
sibling, or `../control-plane/admission/dedup` — were NOT flagged, so agent code
outside the admission package could import a stage directly and bypass the
gateway. Bare side-effect imports were missed too.

**Fix:** `isAdmissionBypass` (and the runner) now (1) resolve relative specs and
`@/` aliases to a repo-relative path before matching, and (2) match bare
`import '...'` side-effect imports. Added 3 tests covering relative + traversal
cases.

**Re-verification:** relative probe `./admission/normalize` and bare probe now
return `FAIL — 1 bypass`; clean run PASS. Full suite green. See
`evidence/vercel-fix.txt`.
