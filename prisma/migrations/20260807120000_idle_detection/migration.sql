-- Staff idle-detection pilot (Imou camera). One row per ongoing off-task episode.
-- Additive only — safe to run on production before the feature is enabled.

CREATE TABLE IF NOT EXISTS "idle_episodes" (
  "id"           TEXT NOT NULL,
  "category"     TEXT NOT NULL,
  "device_id"    TEXT NOT NULL,
  "started_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at"     TIMESTAMP(3),
  "notified_at"  TIMESTAMP(3),
  "snapshot_url" TEXT,
  "note"         TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idle_episodes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idle_episodes_category_device_id_ended_at_idx"
  ON "idle_episodes" ("category", "device_id", "ended_at");
