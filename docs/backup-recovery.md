# Alma ERP Backup and Recovery Runbook

This runbook protects production PostgreSQL data for Alma Lifestyle, Alma Trading, and Creative Digital IT.

## Backup Architecture

Backups run outside user request paths with `scripts/backup-production.mjs`.

Artifacts:

- Full database backup: `pg_dump --format=custom --compress=9 --no-owner --no-acl`
- Schema-only backup: `pg_dump --schema-only --format=custom --compress=9 --no-owner --no-acl`
- Metadata backup: compressed JSON with restore notes and required env checklist
- Manifest: file names, sizes, SHA-256 checksums

Storage:

```text
ALMA ERP Backups/
  Daily/
  Weekly/
  Monthly/
  Manual/
```

The script uploads artifacts through the protected Google Apps Script route `backup_upload`, which validates size and SHA-256 before creating Drive files.

## Required Environment

Backup runner:

- `BACKUP_DATABASE_URL` or `DIRECT_DATABASE_URL` or `DATABASE_URL`
- `BACKUP_GAS_URL` or `NEXT_PUBLIC_API_URL`
- `BACKUP_API_SECRET` or `API_SECRET`
- `RESEND_API_KEY` and `BACKUP_ALERT_EMAILS` for failure alerts
- `pg_dump` available in the runner environment

Local macOS setup, if you want to run backups manually:

```bash
brew install libpq
brew link --force libpq
```

Apps Script:

- `API_SECRET` must match the ERP secret
- Drive permission must be granted for the deployed script

## Retention Policy

Default policy:

- Daily backups: keep 14 days
- Weekly backups: keep 8 weeks
- Monthly backups: keep 13 months

Run kinds:

```bash
npm run backup:prod -- --kind=daily
npm run backup:prod -- --kind=weekly
npm run backup:prod -- --kind=monthly
```

Retention cleanup is available via GAS route `backup_retention_cleanup`.

## Validation

Dry run:

```bash
npm run backup:dry-run
```

Full backup without upload:

```bash
npm run backup:prod -- --kind=manual --no-upload
```

Automated GitHub recovery validation:

```text
Actions -> Recovery Validation -> Run workflow
```

The workflow creates a fresh production-safe backup with `pg_dump`, verifies the manifest and SHA-256 hashes, restores into a GitHub Actions local PostgreSQL service database, runs Prisma/application validation against that isolated database, uploads a validation report artifact, and drops the restored schema during cleanup.

The workflow intentionally does not restore into Supabase, Vercel, or any persistent production-adjacent database.

## GitHub Secrets

Required for `.github/workflows/recovery-validation.yml`:

- `BACKUP_DATABASE_URL`: read-only-capable PostgreSQL connection string for production backup generation.
  - Example: `postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require`
  - Prefer a direct or transaction-pool-compatible backup connection.
  - Must not point to the GitHub Actions recovery service.

Optional for recovery validation failure alerts:

- `RESEND_API_KEY`: Resend API key.
- `BACKUP_ALERT_EMAILS`: comma-separated admin emails.
  - Example: `owner@example.com,admin@example.com`
- `EMAIL_FROM`: verified sender.
  - Example: `Alma ERP <alerts@yourdomain.com>`

Required for `.github/workflows/production-backup.yml` Drive uploads:

- `BACKUP_DATABASE_URL`: same format as above.
- `BACKUP_GAS_URL`: deployed Google Apps Script web app URL.
- `BACKUP_API_SECRET`: same strong secret configured in Apps Script `API_SECRET`.

Optional backup workflow secrets:

- `RESEND_API_KEY`
- `BACKUP_ALERT_EMAILS`
- `EMAIL_FROM`

No multiline secrets are required for the current GitHub workflows.

## Recovery Database Strategy

Recommended safest strategy for recurring validation:

- Use the built-in GitHub Actions `postgres:16` service database.
- It is disposable, isolated, low-cost, and automatically destroyed with the runner.
- The recovery URL is hardcoded to `localhost` inside the workflow:

```text
postgresql://recovery:recovery@localhost:5432/alma_recovery
```

The recovery script refuses to run when production and recovery URLs match. It also refuses non-local recovery databases unless `ALLOW_EXTERNAL_RECOVERY_DB=true` is explicitly set.

Alternative strategies for manual disaster drills:

- Temporary Neon branch/database.
- Temporary Supabase project.
- Railway disposable Postgres.

Use these only with `ALLOW_EXTERNAL_RECOVERY_DB=true`, and delete the database after the test.

After backup:

1. Confirm all expected files exist in Drive.
2. Compare manifest SHA-256 with downloaded artifact SHA-256.
3. Confirm non-zero file sizes.
4. Keep the manifest with every restore ticket.

## Restore Workflow

Never restore directly over production first.

1. Create a fresh pre-restore production backup.
2. Create a clean recovery database.
3. Restore into recovery database:

```bash
pg_restore --clean --if-exists --no-owner --no-acl --dbname "$RECOVERY_DATABASE_URL" alma-erp-daily-YYYY.dump
```

4. Run:

```bash
npx prisma migrate status
npx prisma validate
```

5. Smoke test:

- Login/auth
- Orders and invoices
- Trading accounts/trades/analytics
- Wallet and payroll summaries
- Attendance and waiver history
- Notifications
- Screenshot metadata

6. If recovery database is valid, schedule a maintenance window.
7. Point production app to the recovered database or perform managed database-level restore.
8. Run production smoke tests again before staff resume operations.

## Rollback Safety

- Keep the old database untouched until recovery is verified.
- Keep the pre-restore backup for at least 30 days.
- Do not run destructive migrations during restore.
- Confirm Prisma migration history matches application code before traffic is restored.

## Operational Risks

- Large databases may exceed Apps Script web payload limits. If compressed backups exceed about 30 MB, move uploads to direct Google Drive API or object storage.
- `pg_dump` must use a direct or transaction-pool-safe URL. If session-pool limits are hit, use a dedicated backup connection string.
- Backups include sensitive data. Limit Drive folder access to owner/Super Admin only.
- Environment secrets are not exported by design. Keep the env checklist updated and store actual secrets in the approved password manager/Vercel/Supabase dashboards.
