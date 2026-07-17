# NP-4 — Agent remainder + native authentication recovery (completion evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a`

## What shipped

1. **AU-01 Forgot password** ([NativeAuthRecoverySwiftUI.swift](../ios/App/App/NativeAuthRecoverySwiftUI.swift)): native form → POST /api/auth/forgot-password (web payload verbatim), neutral anti-enumeration success copy, native-login return link. NativeLoginScreen's "Forgot password?" now routes here (was forced-web).
2. **AU-02 Reset password:** deep link `…/reset-password?token=…` handled natively — new `AlmaNavCoordinator.queryCapableRoutes` lets a typed query route go native (before: any query forced web). Token lives ONLY in view state (never logged/persisted), POST /api/auth/reset-password, password cleared on success, returns to native login via `.almaOpenPath`.
3. **FN-01 /portal/wallet:** `PortalWalletRouteScreen` resolves the signed-in employee (GET /api/users/me, PortalVM parity) → existing native `WalletStatementScreen`. Route contract → native.
4. **AG-10 Growth GSC:** connect via **ASWebAuthenticationSession** (starts at /api/assistant/growth/gsc-auth, https-callback on /agent/growth?gsc=…; iOS 17.4+ — pre-17.4 keeps the web fallback), disconnect = native DELETE gsc-status with Bangla confirm + server-refresh.
5. **AG-11 Costs CSV:** native export — GET /api/assistant/costs/export → temp `.csv` → system share sheet. The page's last web escape ("বাজেট কনফিগ / CSV — ওয়েবে খুলুন") is GONE (budget config was already native).
6. **AG-12 Creative Studio:** Drive connect/disconnect native via the same OAuth session helper + DELETE drive-status (the "opens the whole web Studio" tool row removed). **Finding:** the drag/resize Lifestyle Editor was ALREADY fully native (`CSLifestyleEditorSwiftUI` drag geometry) — the audit's stale-comment caveat applied to its own ledger here; revalidated in code, no rebuild (do-not-rebuild rule).
7. **AG-13 demo route:** iOS never routes to it (temporary-web, fail-loud). The web `page.tsx` deletion is deferred to the merge — this branch must stay ios/docs/scripts-only so Vercel never builds it (owner constraint). Noted in contract.

New shared helper: `AlmaWebAuthSession` — OAuth round-trips that start at an ALMA 302 endpoint and end on an ALMA https page (system-handoff EX-04).

## Verification

- `xcodebuild … iPhone 17 Pro Max build` → **BUILD SUCCEEDED**
- Route checker → OK: **66 native-required / 1 temporary-web** (only creative-studio-demo) / 3 public — temporary-web list no longer contains Live Watch, forgot, reset, or wallet (NP-4 exit gate ✓).
- Feature checker → OK: open actions 53 → **44**; openWeb snapshot: CreditUsage 2→1, NativeLogin 2→1 (escapes removed), CreativeStudio 2→3 (documented pre-17.4 OAuth fallback).
- OAuth round-trips (Google consent) are owner-hardware checks at NP-9 — the simulator cannot complete real Google consent.
