# SPEC-051 Contract — Transcript
`TranscriptEntry {id,role,content,identity,atMs}`, `transcriptEntrySchema`, `ConversationTranscript` (append frozen, entries() copy, forTenant, size). Fail-closed on invalid. Rollback: `git revert --no-edit <SPEC-051 commit>`.
