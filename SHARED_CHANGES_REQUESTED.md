# SHARED CHANGES QUEUE (append-only)

Parallel page sessions may NOT edit frozen/shared files (NATIVE_MIGRATION_HANDOFF.md §2).
Instead they APPEND a request here and keep working. The OWNER applies these centrally,
serially, between sessions, then marks them ✅ APPLIED (with commit hash).

**Never rewrite or delete another session's entry. Add yours at the bottom.**

## Entry format (copy this block)

```
### [PENDING] <page-slug> — <one-line title>
- Session: native/<page-slug>   Date: YYYY-MM-DD
- File(s): <exact frozen file path(s)>
- Exact change: <precise diff-level description — e.g. the 4 pbxproj entries for
  ios/App/App/FooSwiftUI.swift, or "add More-menu row X → FooScreen">
- Why: <one sentence — what breaks without it>
```

Owner flips `[PENDING]` → `[✅ APPLIED <commit>]` or `[❌ REJECTED — reason]`.

---

## Queue

(empty — no pending requests)
