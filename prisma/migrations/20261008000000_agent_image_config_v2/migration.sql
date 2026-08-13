-- Additive only. v2 professional image setup: the canonical pending render
-- selection and its optimistic-concurrency revision. Legacy rows keep NULL
-- config and revision 0 and continue through the v1 model-only path.
--
-- IF NOT EXISTS: the same columns already shipped to the shared database via
-- main's 20261012000000_agent_image_config_v2 (merged 2026-08-12). Without
-- the guard this file failed on every preview build of this branch and its
-- stuck _prisma_migrations row P3009-blocked EVERY deploy of the project.
ALTER TABLE "agent_pending_actions"
  ADD COLUMN IF NOT EXISTS "image_config" JSONB,
  ADD COLUMN IF NOT EXISTS "image_config_revision" INTEGER NOT NULL DEFAULT 0;
