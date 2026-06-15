-- Per-session model selector default for owner /agent conversations
ALTER TABLE "agent_conversations"
  ALTER COLUMN "model" SET DEFAULT 'claude-sonnet-4-6';

UPDATE "agent_conversations"
SET "model" = 'claude-sonnet-4-6'
WHERE "model" IS NULL;
