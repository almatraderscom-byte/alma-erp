# SPEC-159 Contract — Provider failover rules
- `shouldFailover(outcome)` — true only for TIMEOUT / RETRYABLE (transient).
  FINAL (permanent) and UNKNOWN (reconciliation, INV-06) never fail over; OK stops.
- `createFailoverAttemptRunner({clock, quota?})` — fabric `AttemptRunner` that
  iterates the tier's ORDERED candidate list: transient failure / quota deny /
  missing adapter → next candidate; permanent/unknown → stop; success → return.
  All candidates exhausted → `MODEL_ALL_PROVIDERS_FAILED` (RETRYABLE).
- Failover stays strictly WITHIN the tier (candidates are same-tier equivalents) —
  it never escalates to a stronger/costlier tier.
