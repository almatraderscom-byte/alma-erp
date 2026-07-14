-- Roadmap Phase 3 (docs/ios-stability-roadmap.md): canonical durable turn.
-- Additive only — nullable columns + defaults; legacy rows and clients unaffected.

ALTER TABLE "agent_turns" ADD COLUMN IF NOT EXISTS "client_message_id" TEXT;
ALTER TABLE "agent_turns" ADD COLUMN IF NOT EXISTS "user_message_id" TEXT;
ALTER TABLE "agent_turns" ADD COLUMN IF NOT EXISTS "assistant_message_id" TEXT;
ALTER TABLE "agent_turns" ADD COLUMN IF NOT EXISTS "last_seq" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "agent_turns" ADD COLUMN IF NOT EXISTS "execution_mode" TEXT;
ALTER TABLE "agent_turns" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- One turn per (conversation, clientMessageId). Postgres unique indexes ignore
-- NULLs, so legacy rows (no key) can repeat freely.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_turns_conversation_id_client_message_id_key"
  ON "agent_turns"("conversation_id", "client_message_id");

-- Fresh-conversation retries look the turn up by key alone (no conversation yet).
CREATE INDEX IF NOT EXISTS "agent_turns_client_message_id_idx"
  ON "agent_turns"("client_message_id");
