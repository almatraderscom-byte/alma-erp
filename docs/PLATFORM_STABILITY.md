# Alma ERP — platform stability & regression architecture

## Root causes of regression instability

1. **Large shared shell** — `AppProviders` → `ErpChrome` → sidebar, mobile nav, notifications, pull-to-refresh, and multiple context providers. A change in one provider affects every module.

2. **Isolated feature patches** — Fixes land in module files without re-validating shell z-index, Telegram queue, or Prisma transaction paths used elsewhere.

3. **Untracked / uncommitted shared UI** — Example: `DeveloperWatermark.tsx` existed locally but was never committed, so production never received it.

4. **Implicit z-index competition** — Mobile nav `z-50`, watermark was `z-20`, modals `z-[10000]`. Credit text was painted *under* the bottom bar.

5. **Async side effects after DB commit** — Attendance check-in, approval resolve, and Telegram enqueue are separate steps; cron timing creates race windows (addressed for absent alerts in `attendance-absent-safety.ts`).

6. **Multi-business scope** — `businessAccess` parsing differs between `contains` (legacy monitor) and `userHasBusinessAccess` (dashboard). Cross-business employees need explicit rules.

7. **No mandatory regression gate** — Deploy runbook lacked a checklist; see `docs/REGRESSION_CHECKLIST.md`.

## Shared layout findings

| Area | Finding | Mitigation |
|------|---------|------------|
| Root layout | Single `layout.tsx`; watermark must live here | `GlobalPlatformChrome` |
| `ErpChrome` | `overflow-hidden` on shell — do not move watermark inside main scroll | Keep watermark as body sibling |
| Mobile nav | `fixed bottom-0 z-50` | Watermark `PLATFORM_Z.watermark` = 52 |
| Modals | Approvals `z-[10000]`, trading modals same | Watermark stays below modals (correct) |
| Loading overlay | `z-[240]` covers shell during auth | Expected; watermark hidden until loaded |
| Public routes | Login uses compact watermark bottom offset | `useCompactBottom()` |

## Regression protection architecture

```
Root layout
├── AppProviders (session, business, branding, chrome)
│   └── ErpChrome (sidebar, main, mobile nav, notifications)
└── GlobalPlatformChrome
    ├── DeveloperWatermark (data-platform-watermark)
    └── PlatformDiagnostics (logs missing watermark / hydration)
```

**Diagnostics events** (`src/lib/platform-diagnostics.ts`):

- `platform.shell.mounted`
- `platform.watermark.missing`
- `platform.shell.hydration_mismatch` (development)

**Z-index scale** — `src/lib/platform-z-index.ts` (documented constants).

## Shared components — do not break silently

| Component | Used by |
|-----------|---------|
| `EmployeeAvatar` | Approvals, attendance, portal, employees |
| `MobileNavChrome` / `MobileNav` | All authenticated mobile views |
| `toast` (react-hot-toast) | Most client actions |
| `useApprovalActions` | Approvals page only — do not duplicate fetch in API |
| `telegram-notification/queue` | Attendance, trading, payroll, penalties |
| `useRegisterMobileRefresh` | Dashboards that poll on mobile resume |

## Page header / Alerts architecture

- **`PageHeader`** + **`PageActionBar`**: flex-wrap action row; Alerts is the last in-flow item on `md+`.
- **`AlertsActionButton`**: must never use `fixed` positioning (overlaps page actions — e.g. Orders “+ New Order”).
- **Mobile**: Alerts remains in bottom nav (`MobileNav`); header Alerts hidden via `hidden md:inline-flex`.
- **Z-index**: sticky page header uses `PLATFORM_Z.stickyBanner` (70); notification panel uses `PLATFORM_Z.notificationPanel` (160).

## UI consistency rules

- Loading: prefer `Spinner` / `Skeleton` / `LoadingOverlay` from `@/components/ui` and `loading/*`
- Errors: `toast.error` with actionable message; API returns `{ error }`
- Mobile actions: min 44px touch targets; `safe-area-inset` on fixed chrome
- Fetch: `cache: 'no-store'` for operational data (attendance, approvals)

## Long-term recommendations

1. Run `docs/REGRESSION_CHECKLIST.md` before every production deploy.
2. Prefer changes in shared libs with explicit consumers listed in PR description.
3. Add Playwright smoke tests for shell + watermark + check-in (future).
4. Monitor `platform.watermark.missing` and `attendance.false_positive_blocked` in production logs.
