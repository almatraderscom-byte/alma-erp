# Alma ERP — mandatory pre-deploy regression checklist

**Rule:** No production deploy until every section below is checked for the release scope. A feature fix is incomplete if another workflow regresses.

Last updated: 2026-05-20

## 1. Build & types

- [ ] `npx tsc --noEmit` passes
- [ ] Production build succeeds (`npm run build` or Vercel preview)
- [ ] No new secrets committed

## 2. Global shell (always required)

- [ ] **Watermark** — “Developed by Maruf” visible on desktop and mobile (above bottom nav, not clipped)
- [ ] **Mobile bottom nav** — tabs work; no overlap hiding primary actions
- [ ] **Page header actions** — Orders (and other `PageHeader` pages): Alerts + primary buttons do not overlap at 1280px / 1440px desktop widths
- [ ] **Sidebar / business switcher** — loads; switching business does not blank the shell
- [ ] **Login / logout** — session gate; no infinite loading overlay
- [ ] **Notifications panel** — opens from bell; closes without trapping scroll
- [ ] **Pull-to-refresh** (mobile) — does not break scroll on dashboard pages

## 3. Attendance

- [ ] Employee face check-in succeeds (portal, correct business context)
- [ ] Admin attendance dashboard shows present/late counts for active business
- [ ] **No false Telegram absent alert** after check-in (wait through one cron window or verify logs)
- [ ] Face verification CTA appears when admin requests verification

## 4. Approvals

- [ ] Pending list loads
- [ ] Approve shows processing state (banner, row lock, toast) until committed/failed
- [ ] Reject requires note; cannot double-submit
- [ ] Wallet / penalty approve does not hang without feedback

## 5. Telegram Ops

- [ ] Check-in alert delivers (face photo or fallback)
- [ ] Queue health endpoint or settings page shows no stuck `SENDING` rows
- [ ] Absent alert only for genuinely absent employees (see `attendance.false_positive_blocked` logs)

## 6. Payroll & wallet

- [ ] Employee wallet balance loads
- [ ] Withdrawal/advance request creates pending row
- [ ] Super admin can approve from Approvals without transaction timeout

## 7. Profile & avatars

- [ ] `EmployeeAvatar` loads image or initials on Approvals, Attendance, Portal
- [ ] Profile photo upload does not break attendance fetch

## 8. Trading (if release touches trading)

- [ ] Screenshot upload + Telegram notify
- [ ] Trading dashboard loads accounts

## 9. Real devices

- [ ] Android Chrome — watermark + bottom nav + one check-in flow
- [ ] iPhone Safari — same
- [ ] Desktop Chrome — watermark bottom-right, modals above watermark

## 10. Logs (production, after deploy)

- [ ] No spike in `approval.action.failed` or `attendance.check_in.failed`
- [ ] `platform.watermark.missing` absent in logs after navigation

---

## Scope notes

When changing **shared** files, re-run sections 2–3 and any module that imports the changed file:

| Shared surface | Typical dependents |
|----------------|------------------|
| `src/app/layout.tsx`, `AppProviders.tsx` | Entire app |
| `MobileNavChrome`, `Sidebar` | All authenticated routes |
| `EmployeeAvatar`, `profile-resolution` | HR, attendance, approvals, portal |
| `telegram-notification/*` | Attendance, trading, payroll |
| `prisma.ts`, `prisma-transaction.ts` | Approvals, wallet, penalties |

Record deploy verifier name, commit SHA, and date in your release notes.
