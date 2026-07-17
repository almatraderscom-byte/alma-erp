# NP-6 — Trading account and Telegram admin completion (completion evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a`

## What shipped (TR-01 … TR-05, all native)

- **TR-01 Account detail admin** ([TradingAccountAdminSwiftUI.swift](../ios/App/App/TradingAccountAdminSwiftUI.swift), embedded in the detail sheet): trade **audit** view (all fields + status + edit count + delete reason), **edit** (PATCH /api/trading/trades/{id} action:'edit' + editReason), **request/approve/reject delete** (web tradeStatus() gating verbatim: ACTIVE/EDITED rows can edit/request; DELETE_PENDING shows approve/reject to SUPER_ADMIN only — native gate via the owner probe, server enforces regardless); **daily bkash summary** list + native add (whole-taka Int); **full screenshot history** (cursor paging + archived toggle) + **multipart upload** via PhotosPicker (AlmaAPI.uploadMultipart).
- **TR-02 Partnership settlement:** preview (share %, period, trading delta, expense adjustments, NET STAFF OWES, unsettled-expense count), notes + admin override ৳ + post-to-wallet toggle, Bangla confirm naming account + ৳ amount + effect, **before/after verification**: owes-before captured → settle POST → server re-fetch → "আগে ৳X বাকি ছিল, এখন ৳Y · history N→N+1 · wallet posted" line. Settlement history list.
- **TR-03 Telegram drafts:** per-draft **edit sheet** (web saveEdit payload: tradeType/usdtAmount/bdtRate/feeUsdt/tradingAccountId), **bulk select** (PENDING/LOCKED rows only — web rule), select-all-pending, Post-to-ledger with confirm + bulk reject — exact server counts ("Posted N. Failed: M") in the toast.
- **TR-04 Telegram mapping/admin:** link user (POST /users {telegramUserId, username, userId, defaults, approved:true}), **unlink** (DELETE /users/{id}, confirm; idempotent replay reads as success — web rule), alias create (web regex `^[a-z0-9_-]{1,16}$` validation), group **register/approve/deactivate/🧪 test** (POST/PATCH /chats, POST /chats/test), **webhook** status + register (GET/POST /setup).
- **TR-05 Analytics:** Custom date-range chip (start/end YYYY-MM-DD) + min/max ROI inputs — the web's exact query params; native **CSV** (web toCsv columns verbatim: Account/Staff/Status/Health/Net Profit BDT/ROI %) and **A4 PDF** (title + KPI line + rows, web exportPdf content) via system share sheet. Last web escape on the page removed.

## Verification

- `xcodebuild … iPhone 17 Pro Max build` → **BUILD SUCCEEDED**
- Feature checker → OK: open actions 28 → **13** (TR-01..05 native); openWeb snapshot TradingAnalytics 2→1 (escape removed, checker-caught).
- Route checker → OK (70/66).
- Whole-taka BDT preserved: all ৳ writes round to Int before POST (settle override, bkash opening/closing); money before/after assertions run in-app on settle (owes + history delta) — full live fixture pass batched to NP-9 owner session.
