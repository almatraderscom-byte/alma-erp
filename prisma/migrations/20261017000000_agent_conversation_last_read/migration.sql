-- Unread chats on the phone: remember when Boss last OPENED each conversation,
-- so the agent's later replies can be counted as unread. Additive, nullable.
ALTER TABLE "agent_conversations" ADD COLUMN IF NOT EXISTS "last_read_at" TIMESTAMP(3);
