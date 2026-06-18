-- Agent conversation auto-compaction columns.
--
-- These columns exist in schema.prisma but were never migrated to the database,
-- so every compaction query threw at runtime and was silently swallowed by the
-- defensive try/catch in core.ts ("column may not exist"). Result: auto-compaction
-- never ran, conversation history grew unbounded, and each cold turn re-wrote the
-- whole history to the prompt cache at the expensive cache-WRITE rate.
--
-- Additive + idempotent (IF NOT EXISTS): no-op if a prior `prisma db push` already
-- added them; otherwise it brings the DB in line with the schema so compaction works.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS context_summary TEXT;
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS compacted_to_id TEXT;
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
