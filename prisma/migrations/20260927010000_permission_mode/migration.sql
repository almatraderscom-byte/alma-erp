-- PM-1 — per-conversation PERMISSION mode (owner ask 2026-07-27).
--
-- The second axis of the mode picker: chat_mode says HOW the agent works,
-- permission_mode says HOW MUCH it may do without Boss —
-- plan | careful | standard | supervised | elevated.
--
-- NULL means 'standard', which is exactly today's behaviour, so every existing
-- conversation is unchanged. Additive only; safe for the live ERP.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "permission_mode" TEXT;

-- The time-boxed elevation grant that 'elevated' mode runs under:
--   { "families": ["public-publish"], "expiresAt": "2026-07-27T12:30:00.000Z" }
-- A grant without an expiry is not a grant — the server treats it as absent.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "elevation_grant" JSONB;
