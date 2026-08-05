-- HELD CONTROLLED RELEASE SCRIPT — deliberately outside prisma/migrations.
-- Constraints were added NOT VALID by the additive deploy migration. Run the
-- read-only preflight first, rehearse this script on a representative restored
-- database, record timings/locks, and schedule it separately. This workstream
-- has not performed that representative rehearsal and makes no low-lock claim.

-- Optional indexes on existing populated child tables. These statements must
-- be run outside a transaction, one at a time, before constraint validation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_asset_review_events_composition_join_idx"
  ON "creative_asset_review_events"("composition_id", "composition_version_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_asset_review_events_approved_artifact_version_id_idx"
  ON "creative_asset_review_events"("approved_artifact_version_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_publish_deliveries_composition_join_idx"
  ON "creative_publish_deliveries"("composition_id", "composition_version_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_publish_deliveries_operation_batch_join_idx"
  ON "creative_publish_deliveries"("operation_batch_id", "composition_id", "composition_version");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_publish_deliveries_approved_review_event_id_idx"
  ON "creative_publish_deliveries"("approved_review_event_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_performance_snapshots_composition_join_idx"
  ON "creative_performance_snapshots"("composition_id", "composition_version_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_performance_snapshots_operation_batch_join_idx"
  ON "creative_performance_snapshots"("operation_batch_id", "composition_id", "composition_version");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_archive_receipts_composition_join_idx"
  ON "creative_archive_receipts"("composition_id", "composition_version_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "creative_archive_receipts_operation_batch_join_idx"
  ON "creative_archive_receipts"("operation_batch_id", "composition_id", "composition_version");

ALTER TABLE "creative_compositions"
  VALIDATE CONSTRAINT "creative_compositions_brand_scope_fkey";
ALTER TABLE "creative_compositions"
  VALIDATE CONSTRAINT "creative_compositions_project_scope_fkey";

ALTER TABLE "creative_asset_review_events"
  VALIDATE CONSTRAINT "creative_asset_review_events_composition_id_fkey";
ALTER TABLE "creative_asset_review_events"
  VALIDATE CONSTRAINT "creative_asset_review_events_exact_composition_version_fkey";
ALTER TABLE "creative_asset_review_events"
  VALIDATE CONSTRAINT "creative_asset_review_events_approved_artifact_version_id_fkey";
ALTER TABLE "creative_asset_review_events"
  VALIDATE CONSTRAINT "creative_asset_review_events_composition_pin_check";

ALTER TABLE "creative_publish_deliveries"
  VALIDATE CONSTRAINT "creative_publish_deliveries_composition_scope_fkey";
ALTER TABLE "creative_publish_deliveries"
  VALIDATE CONSTRAINT "creative_publish_deliveries_exact_composition_version_fkey";
ALTER TABLE "creative_publish_deliveries"
  VALIDATE CONSTRAINT "creative_publish_deliveries_operation_batch_fkey";
ALTER TABLE "creative_publish_deliveries"
  VALIDATE CONSTRAINT "creative_publish_deliveries_approved_review_event_id_fkey";
ALTER TABLE "creative_publish_deliveries"
  VALIDATE CONSTRAINT "creative_publish_deliveries_composition_pin_check";

ALTER TABLE "creative_performance_snapshots"
  VALIDATE CONSTRAINT "creative_performance_snapshots_composition_id_fkey";
ALTER TABLE "creative_performance_snapshots"
  VALIDATE CONSTRAINT "creative_performance_snapshots_exact_composition_version_fkey";
ALTER TABLE "creative_performance_snapshots"
  VALIDATE CONSTRAINT "creative_performance_snapshots_operation_batch_fkey";
ALTER TABLE "creative_performance_snapshots"
  VALIDATE CONSTRAINT "creative_performance_snapshots_composition_pin_check";

ALTER TABLE "creative_archive_receipts"
  VALIDATE CONSTRAINT "creative_archive_receipts_composition_id_fkey";
ALTER TABLE "creative_archive_receipts"
  VALIDATE CONSTRAINT "creative_archive_receipts_exact_composition_version_fkey";
ALTER TABLE "creative_archive_receipts"
  VALIDATE CONSTRAINT "creative_archive_receipts_operation_batch_fkey";
ALTER TABLE "creative_archive_receipts"
  VALIDATE CONSTRAINT "creative_archive_receipts_composition_pin_check";
ALTER TABLE "creative_archive_receipts"
  VALIDATE CONSTRAINT "creative_archive_receipts_attempts_check";
