-- Unread chats on the phone: remember when Boss last OPENED each conversation,
-- so the agent's later replies can be counted as unread. Additive, nullable.
ALTER TABLE "agent_conversations" ADD COLUMN IF NOT EXISTS "last_read_at" TIMESTAMP(3);

-- Treat everything that already exists as READ. Without this, every chat holding
-- any historical assistant reply would be unread the moment this ships, and the
-- badge's first appearance would be a meaningless "you have 200 unread" — which
-- is exactly how a badge gets ignored forever. Only replies written after the
-- rollout should count.
UPDATE "agent_conversations" SET "last_read_at" = NOW() WHERE "last_read_at" IS NULL;
