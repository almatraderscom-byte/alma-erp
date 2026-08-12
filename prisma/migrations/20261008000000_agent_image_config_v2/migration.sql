-- Additive only. v2 professional image setup: the canonical pending render
-- selection and its optimistic-concurrency revision. Legacy rows keep NULL
-- config and revision 0 and continue through the v1 model-only path.
ALTER TABLE "agent_pending_actions" ADD COLUMN "image_config" JSONB;
ALTER TABLE "agent_pending_actions" ADD COLUMN "image_config_revision" INTEGER NOT NULL DEFAULT 0;
