-- Conversation pinning is a durable, cross-client owner preference.
-- Additive only: existing rows remain unpinned and no data is rewritten.
ALTER TABLE "agent_conversations"
ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "agent_conversations_pinned_updated_at_idx"
ON "agent_conversations" ("pinned", "updatedAt" DESC);
