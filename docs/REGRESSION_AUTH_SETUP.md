# Production regression authentication

Authenticated smoke tests run before every production deploy. **Deploy is blocked** if they fail.

## GitHub Actions secrets (required)

Configure in **GitHub → Repository → Settings → Secrets and variables → Actions**:

| Secret | Required | Description |
|--------|----------|-------------|
| `REGRESSION_BASE_URL` | Yes (or use default in workflow) | `https://alma-erp-six.vercel.app` |
| `DATABASE_URL` | Yes | Production Postgres URL (migration check) |
| `CRON_SECRET` | Yes | Same as Vercel `CRON_SECRET` (telegram cron dry run) |
| `REGRESSION_COOKIE` | Option A | Production SUPER_ADMIN session (see below) |
| `REGRESSION_IDENTIFIER` | Option B | SUPER_ADMIN phone or email |
| `REGRESSION_PASSWORD` | Option B | Password for that user |

Use **either** `REGRESSION_COOKIE` **or** `REGRESSION_IDENTIFIER` + `REGRESSION_PASSWORD`.

### Option A — Session cookie (recommended for stability)

1. Sign in to production as **SUPER_ADMIN**: https://alma-erp-six.vercel.app/login  
2. DevTools → **Application** → **Cookies** → `https://alma-erp-six.vercel.app`  
3. Copy the **value** of `__Secure-next-auth.session-token` (production uses the secure name).  
4. Store locally (never commit):

```bash
# .regression-cookie (gitignored) — full header value only:
__Secure-next-auth.session-token=PASTE_VALUE_HERE
```

5. Push to GitHub (value never echoed):

```bash
gh secret set REGRESSION_COOKIE < .regression-cookie
```

Or use the setup script:

```bash
chmod +x scripts/setup-github-regression-secrets.sh
./scripts/setup-github-regression-secrets.sh
```

**Security:** httpOnly, secure, production-only. Rotate when the session expires (~30 days). Never log or commit the cookie.

### Option B — Credentials (CI-friendly)

```bash
gh secret set REGRESSION_IDENTIFIER --body '+8801…'   # or admin email
gh secret set REGRESSION_PASSWORD --body '…'
```

The smoke runner signs in via NextAuth and obtains a session cookie at runtime (not logged).

## Local pre-deploy

Create `.env.regression.local` (gitignored):

```env
REGRESSION_BASE_URL=https://alma-erp-six.vercel.app
REGRESSION_COOKIE=__Secure-next-auth.session-token=…
# or:
# REGRESSION_IDENTIFIER=admin@example.com
# REGRESSION_PASSWORD=…
DATABASE_URL=…
CRON_SECRET=…
```

Run:

```bash
REQUIRE_REGRESSION_AUTH=1 npm run regression:gate
```

## Verified endpoints (authenticated)

- Attendance admin + me  
- Approvals pending + integrity  
- Payroll wallet requests  
- Telegram ops  
- Business archive modules  
- Operational tasks + my assignments  

## Deployment rule

`.github/workflows/production-deploy-gate.yml` fails if:

- Pending Prisma migrations  
- `type-check` or `build` fails  
- No regression auth secrets  
- Any critical smoke check fails (401, empty body, invalid JSON)
