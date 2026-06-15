-- Smart memory retrieval: importance + usage reinforcement fields
ALTER TABLE "agent_memory" ADD COLUMN IF NOT EXISTS "importance" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "agent_memory" ADD COLUMN IF NOT EXISTS "access_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_memory" ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMP(3);
