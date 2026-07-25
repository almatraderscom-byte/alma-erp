-- Per-conversation execution mode (owner ask 2026-07-25): a mode picker in the
-- chat, like Claude Code's — auto | direct | plan | plan_drive.
-- NULL means "auto", so every existing conversation keeps behaving exactly as it
-- does today. Additive and safe for the live ERP.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "chat_mode" TEXT;
