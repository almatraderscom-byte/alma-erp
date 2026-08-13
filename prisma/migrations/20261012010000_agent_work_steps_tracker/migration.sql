-- Build 103 Issue 3 — exact tracker linkage + durable snapshot for the
-- truthful work-step tracker. Additive and nullable; existing plans need no
-- backfill (they simply never re-attach to a new turn, by design).
ALTER TABLE "agent_plans"
  ADD COLUMN IF NOT EXISTS "origin_turn_id" TEXT,
  ADD COLUMN IF NOT EXISTS "origin_assistant_message_id" TEXT,
  ADD COLUMN IF NOT EXISTS "tracker_snapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "tracker_revision" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "agent_plans_origin_turn_idx"
  ON "agent_plans" ("origin_turn_id");
CREATE INDEX IF NOT EXISTS "agent_plans_origin_message_idx"
  ON "agent_plans" ("origin_assistant_message_id");
