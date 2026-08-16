-- Meta Ads webhook events — durable inbox for pushes that were previously
-- fire-and-forget. Additive only: one new table, nothing existing touched.

CREATE TABLE IF NOT EXISTS "agent_ads_events" (
    "id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "recommendation_type" TEXT,
    "recommendation_hash" TEXT,
    "ad_account_id" TEXT,
    "ad_object_ids" JSONB,
    "meta_message" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'new',
    "detail" JSONB,
    "detail_fetched_at" TIMESTAMP(3),
    "detail_error" TEXT,
    "raw" JSONB NOT NULL,
    "notify_count" INTEGER NOT NULL DEFAULT 0,
    "last_notified_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_ads_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_ads_events_dedupe_key_key"
  ON "agent_ads_events"("dedupe_key");
CREATE INDEX IF NOT EXISTS "agent_ads_events_status_last_seen_idx"
  ON "agent_ads_events"("status", "last_seen_at");
CREATE INDEX IF NOT EXISTS "agent_ads_events_field_last_seen_idx"
  ON "agent_ads_events"("field", "last_seen_at");
