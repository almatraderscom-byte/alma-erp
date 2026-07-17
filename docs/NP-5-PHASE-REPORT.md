# NP-5 — Privileged admin, settings, and bulk workflows (completion evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a`

## What shipped (AD-01 … AD-09, all native)

- **AD-01 Users:** create-account form (email/password/name/phone/role picker/business toggles/HR link/joining/salary), edit form, active toggle with Bangla confirm, admin reset-password (arm-toggle + confirm) — POST/PATCH /api/users(/{id}), POST /{id}/reset-password. Role gates enforced server-side (routes 403 non-admin); reload after every write. Stale "must never gain a POST/PATCH" header replaced (owner-sanctioned NP-5).
- **AD-02 Supplier import:** paste/clipboard/file JSON input → validate (array | {items}) → duplicate preview vs catalog + in-file (sku/name keys, web enrichDrafts essentials) → selectable rows → POST /api/supplier-import/commit {items, skip_duplicate_names} (arbitrary supplier fields reach the server verbatim via a JSON-any bridge) → created/skipped/errors summary.
- **AD-03 Business archive:** dry-run preview (POST /preview → module counts + server confirmationPhrase), typed-phrase-gated execute (exact-match disable), restore batch with confirm — plus audit notice + reload.
- **AD-04 System diagnostics:** Process queue (limit 30), Retry failed (limit 50), per-row Retry single on FAILED rows — per-action spinner, response counts, reload.
- **AD-05 Payment accounts:** mobile/bank create forms (web submitMobile/submitBank payloads), set-default PATCH, DELETE with **Face ID/passcode + confirm**, reveal full number via **LocalAuthentication + server reveal fetch** (masked by default; revealed values session-only).
- **AD-06 Branding:** full field editor per business — company/tagline/phone/email/site/address/Facebook, 3 hex colors (live swatch), invoice prefix, watermark enable + opacity (0–1 validation), 3 footer lines — POST /api/branding {action:'save'} (web api.branding.save verbatim).
- **AD-07 Telegram ops:** owner chat IDs field, 4 schedule minute fields (submit-save, web onBlur parity), 11 alert toggles — PATCH {business_id, <camelCase field>} exactly like web save().
- **AD-08 Notifications:** push-health board (OK/WEB_ONLY/DEAD/NEVER verdict pills + per-device lines) from GET /api/notifications/push-health?scope=all.
- **AD-09 Session:** the session page now EMBEDS the native profile controls (name/phone PATCH /api/users/me + password POST /api/users/me/password) — its web escape is gone.

## Verification

- `xcodebuild … iPhone 17 Pro Max build` → **BUILD SUCCEEDED** (one optional-unwrap fix caught by the build, fixed, rebuilt green)
- Feature checker → OK: open actions 44 → **28**; openWeb snapshot drops recorded (Branding 2→1, Session 2→1, SupplierImport 4→3, SystemDiagnostics 2→1, BusinessArchive 4→2, PaymentAccounts 3→2 — six more internal escapes GONE)
- Route checker → OK (70/66)
- Wrong-role fixture check (exit gate): server-side 403s surface as the auth/error card — full role-matrix cross-check batched to NP-9 owner-approved session.
