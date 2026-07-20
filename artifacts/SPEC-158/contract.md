# SPEC-158 Contract — Provider timeout and quota controls
- `invokeWithTimeout(adapter, call, now)` — brackets a call; elapsed > `timeoutMs`
  → `{kind:'TIMEOUT'}` (deterministic post-hoc; hard abort is a documented seam).
- `createQuotaController({limitPerWindow, windowMs})` — fixed-window per-provider
  limiter; deny → `{ok:false, retryAfterMs}` (definite outcome, INV-06).
- `createGuardedAttemptRunner({clock, quota?})` — fabric `AttemptRunner`: quota
  deny → `MODEL_PROVIDER_QUOTA_EXCEEDED` (provider not called, reservation
  released); timeout → `MODEL_PROVIDER_TIMEOUT` (RETRYABLE, released). Quota state
  is caller-owned so it persists across fabric calls.
