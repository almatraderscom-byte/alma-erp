# iOS Build-73 HANDOFF — penalty-appeal context + photo avatars + native-nav audit

Date: 2026-07-15 · From session: ios-appeal-approval-profile (PR **#375**, MERGED to main `c5ef4c2e`)
To: the **build-73 session agent** (owner of `claude/ios-build-73` / TestFlight upload)

> **মালিকের নির্দেশ (2026-07-15):** TestFlight build 73 বানানোর আগে এই session-এর কাজ + তোমার নিজের কাজ —
> **দুটোই তুমি নিজে simulator-এ verify করবে**, তারপর **Boss-এর explicit confirm নেবে**, তবেই Archive/upload।
> Verify না করে বা Boss-এর go-ahead ছাড়া build করা যাবে না।

This branch already contains all of PR #375 (merged via `c3f0cf4d` origin/main merge) — nothing to cherry-pick.
The API + web halves are **live on production**; the three iOS-native changes below ship only with build 73.

---

## 1. What PR #375 changed (the parts a build-73 sim test must cover)

| # | Change | Files |
|---|---|---|
| 1 | **PENALTY_APPEAL cards tell the fine's own story** — `/api/approvals` now attaches `penaltyAppeal` (fineDate, fineKind LATE/EARLY_LEAVE/NO_CHECKOUT, late/early minutes, checkIn/OutAt, amount, requested relief, appealSubmittedAt); native card + detail sheet render the amber "জরিমানার দিন" box | `src/app/api/approvals/route.ts`, `ios/App/App/ApprovalsSwiftUI.swift` (`PenaltyAppealInfoBox`) |
| 2 | **Photo avatars on approval cards** — requester initials circle → photo via `/api/users/{id}/profile-image` with initials fallback | `ApprovalsSwiftUI.swift` (`ApprovalAvatarCircle`) |
| 3 | **Native-nav deep audit — native screens never escape to web when a native target exists**: tab roots (Dashboard/Orders/Approvals) now route links through `pushSmart`/`AlmaNativeRouter` (`smartOpen(origin:)`); router gained parameterized `/employees/{empId}` (opens native Employees with that employee's detail sheet auto-focused) and `/digital/clients/{id}`; `pushSmart` sends query-carrying deep links to web up front and uses a prefix-based recursion guard | `SwiftUIShell.swift`, `AlmaNativeRouter.swift`, `EmployeesSwiftUI.swift` (`focusEmpId`), `DigitalClientsSwiftUI.swift` (`focusClientId`) |

Still web **by design** (do not "fix"): `/login` fallbacks, every screen's নিজের "ওয়েবে খুলুন" escape button,
query deep-links (`/orders?focus=…`, `/attendance?review=…`), `/trading/accounts/{id}` (native detail screen doesn't exist yet).

## 2. Sim verification checklist for THIS session's work (run on YOUR build of THIS branch)

⚠️ The simulator is shared between sessions — builds overwrite each other (it already happened once on 2026-07-15).
Install **your own fresh build of this branch** immediately before verifying, and verify BOTH workstreams on that one binary.

1. Approvals tab → every PENALTY_APPEAL card shows the amber box: 📅 জরিমানার দিন + (কত দিন আগে) · fine reason with minutes + check-in time · জরিমানা ৳X · চাওয়া · আপিল জমা time. Live data today: Eyafi-র ৳800 fine = **4 Jul 2026, 162 মিনিট দেরি** (appeal submitted 15 Jul) — the box must show 4 Jul, NOT the appeal date.
2. Requester avatars show real photos (Mustahid, Eyafi have photos in prod).
3. Tap a requester name → **native** Employee screen pushes (native header, no WKWebView) and that employee's detail sheet auto-opens (photo, salary, wallet, attendance).
4. Card tap → detail sheet shows "কোন জরিমানার আপিল" box + requester photo avatar.
5. Approvals "সব অপশন — ওয়েবে খুলুন" still opens the WEB page (escape hatch must stay web).
6. Spot-check one query deep link stays web (e.g. Dashboard SLA tile → /orders?status=sla web page).

Reference proofs from my session (already captured, sim, 2026-07-15): fine-box card + native employee sheet —
sent to owner in chat; web live-proof verified on prod `/approvals`.

## 3. Build gate (unchanged, mandatory)

- Sim verify (section 2 + your own checklist in `agent-continuation-ios73-verification.md`) → **তারপর Boss-এর confirm** → only then Archive.
- `bash scripts/ios-build-preflight.sh` before Archive (clean tree, pushed, main-current; branch build needs `ALMA_PREFLIGHT_ALLOW_BRANCH=1` — but for TestFlight the work should land on main first per the build gate).
- Build-number bump to 73 is a COMMIT (`chore(ios): bump build to 73`) pushed BEFORE upload.
- One batched build — no drip builds.
