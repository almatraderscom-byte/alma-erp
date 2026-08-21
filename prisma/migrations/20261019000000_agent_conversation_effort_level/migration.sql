-- Owner's thinking-level picker (2026-08-21): the chosen reasoning effort is a
-- property of the CHAT, exactly like the model pick beside it, so it survives a
-- reload and applies to every following turn of the same conversation.
--
-- Additive + nullable on purpose: NULL = "Auto", which sends no effort knob at
-- all and leaves every existing chat running exactly as it did before.
ALTER TABLE "agent_conversations" ADD COLUMN IF NOT EXISTS "effort_level" TEXT;
