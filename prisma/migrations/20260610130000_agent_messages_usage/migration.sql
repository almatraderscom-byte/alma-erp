-- Agent Module Phase 1: add usage column to agent_messages for full Anthropic token metadata.
-- Additive only — no existing columns modified.
ALTER TABLE "agent_messages" ADD COLUMN "usage" JSONB;
