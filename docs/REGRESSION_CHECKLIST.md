# Alma ERP — Pre-Deploy Regression Checklist

Run before every production deployment. **Do not deploy** if any critical item fails.

## Automated gate

```bash
npm run type-check
npm run build
npm run db:migrate:deploy   # production DB only
REGRESSION_BASE_URL=https://alma-erp-six.vercel.app \
REGRESSION_COOKIE='next-auth.session-token=…' \
node scripts/regression-smoke.mjs
```

## Attendance

- [ ] Admin dashboard loads (`/attendance`) — no “Could not load attendance records”
- [ ] Super Admin “all businesses” scope shows data
- [ ] My Desk employee scope (`scope=me`) loads or shows needs-employee-link
- [ ] Check-in / check-out completes
- [ ] Face verification request does not block check-in
- [ ] Archive visibility `active` / `archived` does not 500 the list API
- [ ] Absent monitor does not false-alert after check-in

## Approvals

- [ ] Pending list loads (`/approvals`)
- [ ] Approve wallet advance — button disabled while processing; survives refresh
- [ ] Reject with note ≥ 5 chars
- [ ] “Pending approval not found” only when row already processed (refresh fixes)
- [ ] No `Unexpected end of JSON input` in browser console
- [ ] Integrity scan loads (Super Admin)

## Telegram

- [ ] Queue enqueue does not block approval/attendance API latency
- [ ] Cron `/api/cron/telegram-notifications` processes pending rows
- [ ] Failed delivery retries; core ERP unaffected on Telegram outage

## Archive

- [ ] Archive Control modules list loads (fail-soft if schema missing)
- [ ] Active records visible by default
- [ ] Archived filter returns only archived (or empty if schema not migrated)

## Payroll / wallet

- [ ] Advance request creates pending approval
- [ ] Withdrawal request creates pending approval
- [ ] Penalty appeal review path works

## Task spotlight

- [ ] Assignment visible on portal
- [ ] Completion updates state
- [ ] Archived tasks hidden in active view

## Observability (production logs)

Confirm structured events appear when failures occur:

- `attendance.api.failed`
- `approval.transaction.failed` / `approval.api.failed`
- `telegram.queue.failed`
- `archive.filter.failed`
- `safeFetchJson.parse.failed` (client dev console)

## Post-deploy smoke

1. Hit `/api/health` on production URL
2. Load attendance + approvals as Super Admin
3. Process one Telegram queue batch (cron or admin)
4. Verify one pending approval end-to-end
