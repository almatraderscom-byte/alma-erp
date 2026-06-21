-- B3: tail compaction (primary, cheap replacement for the $25 cost valve).
--
-- The oldest turns of a long conversation are folded into a single running
-- summary (`tail_summary`) that rides the STABLE/cached system block, while the
-- recent turns stay verbatim. `tail_compacted_count` is the watermark — how many
-- of the oldest messages the summary already represents — so folding happens in
-- stable batches (one prompt-cache write per fold, byte-stable in between).
--
-- Additive + idempotent (IF NOT EXISTS): safe to re-run; no existing data touched.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS tail_summary TEXT;
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS tail_compacted_count INTEGER NOT NULL DEFAULT 0;
