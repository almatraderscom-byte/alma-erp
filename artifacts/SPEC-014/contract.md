# SPEC-014 Contract — Task envelope
`TaskEnvelope {identity, channel, text, command, hasAttachments, fastPath,
classifications, contractVersion}`; `buildEnvelope(receipt)` → typed
ComponentResult (fail-closed if not normalized); `taskEnvelopeSchema` (zod);
version 1.0.0. The pinned interface to G04/G05. Rollback: `git revert --no-edit <SPEC-014 commit>`.
