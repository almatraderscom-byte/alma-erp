-- Creative Studio Enterprise CSE7 — distribution, attribution, and retention.
-- Additive only. No existing ERP or Creative Studio rows are rewritten.

CREATE TYPE "CreativePublishPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM');
CREATE TYPE "CreativePublishStatus" AS ENUM (
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED_RETRYABLE',
  'NEEDS_REVIEW',
  'CANCELED'
);

CREATE TABLE "creative_publish_deliveries" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "brand_profile_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "asset_version_id" TEXT NOT NULL,
  "recipe_id" TEXT,
  "campaign_pack_id" TEXT,
  "scene_key" TEXT NOT NULL DEFAULT 'unclassified',
  "approved_review_event_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "platform" "CreativePublishPlatform" NOT NULL,
  "page_ref" TEXT NOT NULL,
  "caption" TEXT NOT NULL,
  "media_storage_path" TEXT NOT NULL,
  "ad_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "status" "CreativePublishStatus" NOT NULL DEFAULT 'SCHEDULED',
  "scheduled_for" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_started_at" TIMESTAMP(3),
  "next_attempt_at" TIMESTAMP(3),
  "external_post_id" TEXT,
  "permalink_url" TEXT,
  "verified_at" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "receipt" JSONB NOT NULL DEFAULT '{}',
  "last_error_code" TEXT,
  "last_error_message" TEXT,
  "metrics_last_synced_at" TIMESTAMP(3),
  "metrics_next_sync_at" TIMESTAMP(3),
  "metrics_last_error" TEXT,
  "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "creative_publish_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_publish_deliveries_owner_id_idempotency_key_key"
  ON "creative_publish_deliveries"("owner_id", "idempotency_key");
CREATE INDEX "creative_publish_deliveries_status_scheduled_for_idx"
  ON "creative_publish_deliveries"("status", "scheduled_for");
CREATE INDEX "creative_publish_deliveries_owner_id_created_at_idx"
  ON "creative_publish_deliveries"("owner_id", "created_at" DESC);
CREATE INDEX "creative_publish_deliveries_brand_profile_id_created_at_idx"
  ON "creative_publish_deliveries"("brand_profile_id", "created_at" DESC);
CREATE INDEX "creative_publish_deliveries_project_id_created_at_idx"
  ON "creative_publish_deliveries"("project_id", "created_at" DESC);
CREATE INDEX "creative_publish_deliveries_asset_id_created_at_idx"
  ON "creative_publish_deliveries"("asset_id", "created_at" DESC);
CREATE INDEX "creative_publish_deliveries_campaign_pack_id_idx"
  ON "creative_publish_deliveries"("campaign_pack_id");
CREATE INDEX "creative_publish_deliveries_metrics_next_sync_at_idx"
  ON "creative_publish_deliveries"("metrics_next_sync_at");

CREATE TABLE "creative_performance_snapshots" (
  "id" TEXT NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "asset_version_id" TEXT NOT NULL,
  "campaign_pack_id" TEXT,
  "external_object_id" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'meta_graph',
  "source_fingerprint" TEXT NOT NULL,
  "reach" INTEGER NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "engagements" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "conversions" INTEGER NOT NULL DEFAULT 0,
  "spend_amount" DECIMAL(14,2),
  "spend_currency" TEXT,
  "revenue_bdt" INTEGER,
  "raw_metrics" JSONB NOT NULL DEFAULT '{}',
  "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "creative_performance_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_performance_snapshots_source_fingerprint_key"
  ON "creative_performance_snapshots"("source_fingerprint");
CREATE INDEX "creative_performance_snapshots_delivery_id_captured_at_idx"
  ON "creative_performance_snapshots"("delivery_id", "captured_at" DESC);
CREATE INDEX "creative_performance_snapshots_asset_version_id_captured_at_idx"
  ON "creative_performance_snapshots"("asset_version_id", "captured_at" DESC);
CREATE INDEX "creative_performance_snapshots_campaign_pack_id_captured_at_idx"
  ON "creative_performance_snapshots"("campaign_pack_id", "captured_at" DESC);

CREATE TABLE "creative_recipe_performance_weights" (
  "id" TEXT NOT NULL,
  "recipe_id" TEXT NOT NULL,
  "scene_key" TEXT NOT NULL,
  "weight" INTEGER NOT NULL DEFAULT 100,
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "creative_recipe_performance_weights_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_recipe_performance_weights_recipe_id_scene_key_key"
  ON "creative_recipe_performance_weights"("recipe_id", "scene_key");
CREATE INDEX "creative_recipe_performance_weights_recipe_id_weight_idx"
  ON "creative_recipe_performance_weights"("recipe_id", "weight" DESC);

CREATE TABLE "creative_performance_feedback_events" (
  "id" TEXT NOT NULL,
  "weight_id" TEXT NOT NULL,
  "source_snapshot_id" TEXT NOT NULL,
  "winner_asset_version_id" TEXT NOT NULL,
  "compared_version_ids" JSONB NOT NULL DEFAULT '[]',
  "score" INTEGER NOT NULL,
  "previous_weight" INTEGER NOT NULL,
  "next_weight" INTEGER NOT NULL,
  "reason_code" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "creative_performance_feedback_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_performance_feedback_events_source_snapshot_id_key"
  ON "creative_performance_feedback_events"("source_snapshot_id");
CREATE INDEX "creative_performance_feedback_events_weight_id_created_at_idx"
  ON "creative_performance_feedback_events"("weight_id", "created_at" DESC);

CREATE TABLE "creative_retention_policies" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "archive_enabled" BOOLEAN NOT NULL DEFAULT true,
  "delete_originals_enabled" BOOLEAN NOT NULL DEFAULT true,
  "retention_days" INTEGER NOT NULL DEFAULT 30,
  "verification_grace_hours" INTEGER NOT NULL DEFAULT 24,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "creative_retention_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_retention_policies_owner_id_key"
  ON "creative_retention_policies"("owner_id");

CREATE TABLE "creative_archive_receipts" (
  "id" TEXT NOT NULL,
  "pending_action_id" TEXT NOT NULL,
  "asset_version_id" TEXT,
  "storage_path" TEXT NOT NULL,
  "drive_file_id" TEXT NOT NULL,
  "drive_web_view_url" TEXT,
  "size_bytes" BIGINT,
  "archived_at" TIMESTAMP(3) NOT NULL,
  "verified_at" TIMESTAMP(3),
  "last_verified_at" TIMESTAMP(3),
  "original_deleted_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "last_error_code" TEXT,
  "last_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "creative_archive_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_archive_receipts_pending_action_id_storage_path_key"
  ON "creative_archive_receipts"("pending_action_id", "storage_path");
CREATE INDEX "creative_archive_receipts_verified_at_original_deleted_at_idx"
  ON "creative_archive_receipts"("verified_at", "original_deleted_at");
CREATE INDEX "creative_archive_receipts_asset_version_id_idx"
  ON "creative_archive_receipts"("asset_version_id");

ALTER TABLE "creative_publish_deliveries"
  ADD CONSTRAINT "creative_publish_deliveries_brand_profile_id_fkey"
  FOREIGN KEY ("brand_profile_id") REFERENCES "creative_brand_profiles"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_publish_deliveries"
  ADD CONSTRAINT "creative_publish_deliveries_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "creative_projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_publish_deliveries"
  ADD CONSTRAINT "creative_publish_deliveries_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "creative_project_assets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_publish_deliveries"
  ADD CONSTRAINT "creative_publish_deliveries_asset_version_id_fkey"
  FOREIGN KEY ("asset_version_id") REFERENCES "creative_asset_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_publish_deliveries"
  ADD CONSTRAINT "creative_publish_deliveries_recipe_id_fkey"
  FOREIGN KEY ("recipe_id") REFERENCES "creative_brand_recipes"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "creative_performance_snapshots"
  ADD CONSTRAINT "creative_performance_snapshots_delivery_id_fkey"
  FOREIGN KEY ("delivery_id") REFERENCES "creative_publish_deliveries"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_performance_snapshots"
  ADD CONSTRAINT "creative_performance_snapshots_asset_version_id_fkey"
  FOREIGN KEY ("asset_version_id") REFERENCES "creative_asset_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_recipe_performance_weights"
  ADD CONSTRAINT "creative_recipe_performance_weights_recipe_id_fkey"
  FOREIGN KEY ("recipe_id") REFERENCES "creative_brand_recipes"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_performance_feedback_events"
  ADD CONSTRAINT "creative_performance_feedback_events_weight_id_fkey"
  FOREIGN KEY ("weight_id") REFERENCES "creative_recipe_performance_weights"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_performance_feedback_events"
  ADD CONSTRAINT "creative_performance_feedback_events_source_snapshot_id_fkey"
  FOREIGN KEY ("source_snapshot_id") REFERENCES "creative_performance_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_archive_receipts"
  ADD CONSTRAINT "creative_archive_receipts_asset_version_id_fkey"
  FOREIGN KEY ("asset_version_id") REFERENCES "creative_asset_versions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
