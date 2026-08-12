-- Build 103 Issue 2 — additive, nullable canonical image render config + a
-- monotonic revision for atomic multi-field edit/approve compare-and-set.
-- Existing v1 cards (image_config IS NULL) require no backfill and keep the
-- legacy model-only edit path.
ALTER TABLE "agent_pending_actions"
  ADD COLUMN IF NOT EXISTS "image_config" JSONB,
  ADD COLUMN IF NOT EXISTS "image_config_revision" INTEGER NOT NULL DEFAULT 0;
