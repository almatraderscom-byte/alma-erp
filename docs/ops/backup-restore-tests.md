# Backup restore drill log

Record each scratch-restore test here (never restore into production).

| Date (UTC) | Dump file | Restored to | agent_conversations | agent_finance_ledger | lifestyle_orders | Result | Notes |
|------------|-----------|-------------|---------------------|----------------------|------------------|--------|-------|
| _pending_ | — | VPS scratch DB | — | — | — | **Not yet run** | Run Part 2 on VPS after `feat/backup-lifestyle-tables` deploys and one nightly backup completes |

## Commands (VPS)

```bash
ls -lh /opt/agent-backups/
tail -20 /opt/agent-backups/backup.log
LATEST=$(ls -t /opt/agent-backups/agent_finance_*.sql.gz | head -1)
gunzip -c "$LATEST" | psql "$SCRATCH_DATABASE_URL"
gunzip -c "$LATEST" | grep -c "COPY public.lifestyle_orders"
```

After a successful drill, append a row with real counts and mark Result **PASS**.
