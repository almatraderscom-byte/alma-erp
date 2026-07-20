# SPEC-012 Contract — Normalization
`normalize(input)` → `NormalizedRequest {channel, text, command, hasAttachments}`
or typed reason; `normalizeStage` (fail-closed: unknown channel → MALFORMED_INPUT,
oversized → OVERSIZED_INPUT). KNOWN_CHANNELS = telegram/assistant/cron/internal.
Zero model calls. Rollback: `git revert --no-edit <SPEC-012 commit>`.
