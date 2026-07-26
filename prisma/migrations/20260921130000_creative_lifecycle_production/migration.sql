-- Creative Studio V3 lifecycle production boundary. Additive only.
-- Explicit transaction markers match this repository's Prisma deploy contract.
BEGIN;

CREATE TYPE "CreativeLifecycleJobKind" AS ENUM ('RENDER', 'EXPORT');
CREATE TYPE "CreativeLifecycleJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCELED', 'NEEDS_REVIEW');
CREATE TYPE "CreativeLifecycleEffectClass" AS ENUM ('ZERO_COST_LOCAL', 'PAID');

ALTER TABLE "creative_asset_review_events"
  ADD COLUMN "composition_id" TEXT,
  ADD COLUMN "composition_version_id" TEXT,
  ADD COLUMN "composition_version" INTEGER,
  ADD COLUMN "composition_document_hash" TEXT,
  ADD COLUMN "approved_artifact_version_id" TEXT;

ALTER TABLE "creative_publish_deliveries"
  ADD COLUMN "composition_id" TEXT,
  ADD COLUMN "composition_version_id" TEXT,
  ADD COLUMN "composition_version" INTEGER,
  ADD COLUMN "composition_document_hash" TEXT,
  ADD COLUMN "operation_batch_id" TEXT,
  ADD COLUMN "review_fingerprint" TEXT,
  ADD COLUMN "render_fingerprint" TEXT;

ALTER TABLE "creative_performance_snapshots"
  ADD COLUMN "composition_id" TEXT,
  ADD COLUMN "composition_version_id" TEXT,
  ADD COLUMN "composition_version" INTEGER,
  ADD COLUMN "composition_document_hash" TEXT,
  ADD COLUMN "operation_batch_id" TEXT,
  ADD COLUMN "review_fingerprint" TEXT,
  ADD COLUMN "render_fingerprint" TEXT;

ALTER TABLE "creative_archive_receipts"
  ADD COLUMN "composition_id" TEXT,
  ADD COLUMN "composition_version_id" TEXT,
  ADD COLUMN "composition_version" INTEGER,
  ADD COLUMN "composition_document_hash" TEXT,
  ADD COLUMN "operation_batch_id" TEXT,
  ADD COLUMN "operation_package_checksum" TEXT,
  ADD COLUMN "artifact_checksum" TEXT,
  ADD COLUMN "archive_checksum" TEXT,
  ADD COLUMN "fetch_back_checksum" TEXT,
  ADD COLUMN "fetch_back_verified_at" TIMESTAMP(3),
  ADD COLUMN "playable_proxy_path" TEXT,
  ADD COLUMN "original_storage_path" TEXT,
  ADD COLUMN "render_storage_path" TEXT,
  ADD COLUMN "lineage_manifest" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "creative_lifecycle_jobs" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "brand_profile_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "composition_id" TEXT NOT NULL,
  "composition_version_id" TEXT NOT NULL,
  "composition_version" INTEGER NOT NULL,
  "composition_document_hash" TEXT NOT NULL,
  "operation_batch_id" TEXT,
  "source_artifact_version_id" TEXT NOT NULL,
  "source_storage_path" TEXT NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "source_bytes" BIGINT NOT NULL,
  "approved_review_event_id" TEXT,
  "approved_artifact_version_id" TEXT,
  "review_fingerprint" TEXT,
  "kind" "CreativeLifecycleJobKind" NOT NULL,
  "render_profile" TEXT NOT NULL,
  "output_format" TEXT NOT NULL,
  "renderer_version" TEXT NOT NULL,
  "render_fingerprint" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "effect_class" "CreativeLifecycleEffectClass" NOT NULL DEFAULT 'ZERO_COST_LOCAL',
  "estimated_cost_bdt" INTEGER NOT NULL DEFAULT 0,
  "paid_execution_allowed" BOOLEAN NOT NULL DEFAULT false,
  "status" "CreativeLifecycleJobStatus" NOT NULL DEFAULT 'QUEUED',
  "progress_completed" INTEGER NOT NULL DEFAULT 0,
  "progress_total" INTEGER NOT NULL DEFAULT 4,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "result_storage_path" TEXT,
  "result_checksum" TEXT,
  "result_bytes" BIGINT,
  "result_artifact_version_id" TEXT,
  "verified_at" TIMESTAMP(3),
  "last_error_code" TEXT,
  "last_error_message" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_by_role" "CreativeStudioRole" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creative_lifecycle_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_lifecycle_receipts" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "status" "CreativeLifecycleJobStatus" NOT NULL,
  "storage_path" TEXT,
  "checksum" TEXT,
  "size_bytes" BIGINT,
  "artifact_verified" BOOLEAN NOT NULL DEFAULT false,
  "artifact_version_id" TEXT,
  "composition_document_hash" TEXT NOT NULL,
  "operation_package_checksum" TEXT,
  "playable_proxy_path" TEXT,
  "original_storage_path" TEXT,
  "render_storage_path" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creative_lifecycle_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_lifecycle_audit_events" (
  "id" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_role" "CreativeStudioRole" NOT NULL,
  "idempotency_key" TEXT,
  "request_fingerprint" TEXT,
  "event_type" TEXT NOT NULL,
  "from_status" "CreativeLifecycleJobStatus",
  "to_status" "CreativeLifecycleJobStatus",
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creative_lifecycle_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_lifecycle_feature_flags" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "brand_profile_id" TEXT,
  "project_id" TEXT,
  "role" "CreativeStudioRole",
  "capability" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "dual_read_enabled" BOOLEAN NOT NULL DEFAULT false,
  "legacy_fallback_enabled" BOOLEAN NOT NULL DEFAULT true,
  "canary_percent" INTEGER NOT NULL DEFAULT 0,
  "canary_salt" TEXT,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creative_lifecycle_feature_flags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_lifecycle_flag_audit_events" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "feature_flag_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_role" "CreativeStudioRole" NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "before" JSONB,
  "after" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creative_lifecycle_flag_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_archive_verification_attempts" (
  "id" TEXT NOT NULL,
  "archive_receipt_id" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "expected_checksum" TEXT,
  "archive_checksum" TEXT,
  "fetch_back_checksum" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creative_archive_verification_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_lifecycle_jobs_owner_id_idempotency_key_key"
  ON "creative_lifecycle_jobs"("owner_id", "idempotency_key");
CREATE UNIQUE INDEX "creative_lifecycle_jobs_owner_id_render_fingerprint_key"
  ON "creative_lifecycle_jobs"("owner_id", "render_fingerprint");
CREATE UNIQUE INDEX "creative_lifecycle_jobs_lease_token_key"
  ON "creative_lifecycle_jobs"("lease_token");
CREATE UNIQUE INDEX "creative_lifecycle_jobs_result_artifact_version_id_key"
  ON "creative_lifecycle_jobs"("result_artifact_version_id");
CREATE INDEX "creative_lifecycle_jobs_status_created_at_idx"
  ON "creative_lifecycle_jobs"("status", "created_at");
CREATE INDEX "creative_lifecycle_jobs_brand_profile_id_project_id_created_at_idx"
  ON "creative_lifecycle_jobs"("brand_profile_id", "project_id", "created_at" DESC);
CREATE INDEX "creative_lifecycle_jobs_composition_id_composition_version_created_at_idx"
  ON "creative_lifecycle_jobs"("composition_id", "composition_version", "created_at" DESC);
CREATE INDEX "creative_lifecycle_jobs_render_fingerprint_idx"
  ON "creative_lifecycle_jobs"("render_fingerprint");
CREATE INDEX "creative_lifecycle_receipts_job_id_created_at_idx"
  ON "creative_lifecycle_receipts"("job_id", "created_at");
CREATE INDEX "creative_lifecycle_receipts_artifact_version_id_idx"
  ON "creative_lifecycle_receipts"("artifact_version_id");
CREATE INDEX "creative_lifecycle_audit_events_job_id_created_at_idx"
  ON "creative_lifecycle_audit_events"("job_id", "created_at");
CREATE UNIQUE INDEX "creative_lifecycle_audit_events_job_id_idempotency_key_key"
  ON "creative_lifecycle_audit_events"("job_id", "idempotency_key");
CREATE INDEX "creative_lifecycle_audit_events_actor_id_created_at_idx"
  ON "creative_lifecycle_audit_events"("actor_id", "created_at");
CREATE INDEX "creative_lifecycle_feature_flags_owner_id_capability_idx"
  ON "creative_lifecycle_feature_flags"("owner_id", "capability");
CREATE INDEX "creative_lifecycle_feature_flags_brand_profile_id_project_id_role_idx"
  ON "creative_lifecycle_feature_flags"("brand_profile_id", "project_id", "role");
CREATE INDEX "creative_lifecycle_feature_flags_updated_by_id_idx"
  ON "creative_lifecycle_feature_flags"("updated_by_id");
-- PostgreSQL requires every function used by an index expression to be
-- IMMUTABLE. Enum-to-text casts are not immutable, so exact nullable scope
-- uniqueness is expressed with raw-column partial indexes instead. These six
-- predicates cover every valid scope shape (project scope requires brand).
CREATE UNIQUE INDEX "creative_lifecycle_feature_flags_exact_scope_key"
  ON "creative_lifecycle_feature_flags"("owner_id", "capability")
  WHERE "brand_profile_id" IS NULL AND "project_id" IS NULL AND "role" IS NULL;
CREATE UNIQUE INDEX "creative_lifecycle_feature_flags_exact_scope_role_key"
  ON "creative_lifecycle_feature_flags"("owner_id", "role", "capability")
  WHERE "brand_profile_id" IS NULL AND "project_id" IS NULL AND "role" IS NOT NULL;
CREATE UNIQUE INDEX "creative_lifecycle_feature_flags_exact_scope_brand_key"
  ON "creative_lifecycle_feature_flags"("owner_id", "brand_profile_id", "capability")
  WHERE "brand_profile_id" IS NOT NULL AND "project_id" IS NULL AND "role" IS NULL;
CREATE UNIQUE INDEX "creative_lifecycle_feature_flags_exact_scope_brand_role_key"
  ON "creative_lifecycle_feature_flags"("owner_id", "brand_profile_id", "role", "capability")
  WHERE "brand_profile_id" IS NOT NULL AND "project_id" IS NULL AND "role" IS NOT NULL;
CREATE UNIQUE INDEX "creative_lifecycle_feature_flags_exact_scope_project_key"
  ON "creative_lifecycle_feature_flags"("owner_id", "brand_profile_id", "project_id", "capability")
  WHERE "brand_profile_id" IS NOT NULL AND "project_id" IS NOT NULL AND "role" IS NULL;
CREATE UNIQUE INDEX "creative_lifecycle_feature_flags_exact_scope_project_role_key"
  ON "creative_lifecycle_feature_flags"("owner_id", "brand_profile_id", "project_id", "role", "capability")
  WHERE "brand_profile_id" IS NOT NULL AND "project_id" IS NOT NULL AND "role" IS NOT NULL;
CREATE UNIQUE INDEX "creative_lifecycle_flag_audit_events_owner_id_idempotency_key_key"
  ON "creative_lifecycle_flag_audit_events"("owner_id", "idempotency_key");
CREATE INDEX "creative_lifecycle_flag_audit_events_feature_flag_id_created_at_idx"
  ON "creative_lifecycle_flag_audit_events"("feature_flag_id", "created_at");
CREATE INDEX "creative_lifecycle_flag_audit_events_actor_id_created_at_idx"
  ON "creative_lifecycle_flag_audit_events"("actor_id", "created_at");

-- Composite identities let every lifecycle row prove that its immutable
-- version/batch belongs to the same composition and, for executions and
-- deliveries, that composition belongs to the same owner/brand/project.
-- Prisma deploy wraps this migration in a transaction, so required indexes use
-- ordinary CREATE INDEX. Composition/lifecycle tables are new and default-off;
-- the two pre-existing owner-scope indexes are required before their composite
-- FKs and are covered by the separately timed release rehearsal.
CREATE UNIQUE INDEX "creative_compositions_id_owner_id_brand_profile_id_project_id_key"
  ON "creative_compositions"("id", "owner_id", "brand_profile_id", "project_id");
CREATE UNIQUE INDEX "creative_brand_profiles_id_owner_id_key"
  ON "creative_brand_profiles"("id", "owner_id");
CREATE UNIQUE INDEX "creative_projects_id_owner_id_brand_profile_id_key"
  ON "creative_projects"("id", "owner_id", "brand_profile_id");
CREATE UNIQUE INDEX "creative_composition_versions_id_composition_id_key"
  ON "creative_composition_versions"("id", "composition_id");
CREATE UNIQUE INDEX "creative_composition_versions_exact_identity_key"
  ON "creative_composition_versions"("id", "composition_id", "version", "document_hash");
CREATE UNIQUE INDEX "creative_operation_batches_id_composition_id_key"
  ON "creative_operation_batches"("id", "composition_id");
CREATE UNIQUE INDEX "creative_operation_batches_exact_result_key"
  ON "creative_operation_batches"("id", "composition_id", "result_version");

-- Optional read-path indexes for populated review/publish/performance/archive
-- tables live in the held operational SQL, where they can run CONCURRENTLY
-- outside Prisma's transaction after a representative restored-DB rehearsal.
CREATE INDEX "creative_lifecycle_jobs_composition_version_join_idx"
  ON "creative_lifecycle_jobs"("composition_version_id", "composition_id");
CREATE INDEX "creative_lifecycle_jobs_operation_batch_join_idx"
  ON "creative_lifecycle_jobs"("operation_batch_id", "composition_id", "composition_version");
CREATE INDEX "creative_lifecycle_jobs_source_artifact_version_id_idx"
  ON "creative_lifecycle_jobs"("source_artifact_version_id");
CREATE INDEX "creative_lifecycle_jobs_approved_review_event_id_idx"
  ON "creative_lifecycle_jobs"("approved_review_event_id");
CREATE INDEX "creative_lifecycle_jobs_approved_artifact_version_id_idx"
  ON "creative_lifecycle_jobs"("approved_artifact_version_id");
CREATE INDEX "creative_lifecycle_jobs_created_by_id_idx"
  ON "creative_lifecycle_jobs"("created_by_id");
CREATE INDEX "creative_lifecycle_jobs_result_artifact_version_id_idx"
  ON "creative_lifecycle_jobs"("result_artifact_version_id");
CREATE INDEX "creative_archive_verification_attempts_receipt_attempted_idx"
  ON "creative_archive_verification_attempts"("archive_receipt_id", "attempted_at" DESC);
CREATE UNIQUE INDEX "creative_lifecycle_receipts_single_ready_job_key"
  ON "creative_lifecycle_receipts"("job_id")
  WHERE "status" = 'READY';

ALTER TABLE "creative_lifecycle_receipts"
  ADD CONSTRAINT "creative_lifecycle_receipts_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "creative_lifecycle_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_lifecycle_audit_events"
  ADD CONSTRAINT "creative_lifecycle_audit_events_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "creative_lifecycle_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_asset_review_events"
  ADD CONSTRAINT "creative_asset_review_events_composition_id_fkey"
  FOREIGN KEY ("composition_id") REFERENCES "creative_compositions"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_asset_review_events_exact_composition_version_fkey"
  FOREIGN KEY ("composition_version_id", "composition_id", "composition_version", "composition_document_hash")
  REFERENCES "creative_composition_versions"("id", "composition_id", "version", "document_hash")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_asset_review_events_approved_artifact_version_id_fkey"
  FOREIGN KEY ("approved_artifact_version_id") REFERENCES "creative_asset_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "creative_publish_deliveries"
  ADD CONSTRAINT "creative_publish_deliveries_composition_scope_fkey"
  FOREIGN KEY ("composition_id", "owner_id", "brand_profile_id", "project_id")
  REFERENCES "creative_compositions"("id", "owner_id", "brand_profile_id", "project_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_publish_deliveries_exact_composition_version_fkey"
  FOREIGN KEY ("composition_version_id", "composition_id", "composition_version", "composition_document_hash")
  REFERENCES "creative_composition_versions"("id", "composition_id", "version", "document_hash")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_publish_deliveries_operation_batch_fkey"
  FOREIGN KEY ("operation_batch_id", "composition_id", "composition_version")
  REFERENCES "creative_operation_batches"("id", "composition_id", "result_version")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_publish_deliveries_approved_review_event_id_fkey"
  FOREIGN KEY ("approved_review_event_id") REFERENCES "creative_asset_review_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "creative_performance_snapshots"
  ADD CONSTRAINT "creative_performance_snapshots_composition_id_fkey"
  FOREIGN KEY ("composition_id") REFERENCES "creative_compositions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_performance_snapshots_exact_composition_version_fkey"
  FOREIGN KEY ("composition_version_id", "composition_id", "composition_version", "composition_document_hash")
  REFERENCES "creative_composition_versions"("id", "composition_id", "version", "document_hash")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_performance_snapshots_operation_batch_fkey"
  FOREIGN KEY ("operation_batch_id", "composition_id", "composition_version")
  REFERENCES "creative_operation_batches"("id", "composition_id", "result_version")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "creative_archive_receipts"
  ADD CONSTRAINT "creative_archive_receipts_composition_id_fkey"
  FOREIGN KEY ("composition_id") REFERENCES "creative_compositions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_archive_receipts_exact_composition_version_fkey"
  FOREIGN KEY ("composition_version_id", "composition_id", "composition_version", "composition_document_hash")
  REFERENCES "creative_composition_versions"("id", "composition_id", "version", "document_hash")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_archive_receipts_operation_batch_fkey"
  FOREIGN KEY ("operation_batch_id", "composition_id", "composition_version")
  REFERENCES "creative_operation_batches"("id", "composition_id", "result_version")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "creative_lifecycle_jobs"
  ADD CONSTRAINT "creative_lifecycle_jobs_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_brand_scope_fkey"
  FOREIGN KEY ("brand_profile_id", "owner_id")
  REFERENCES "creative_brand_profiles"("id", "owner_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_project_scope_fkey"
  FOREIGN KEY ("project_id", "owner_id", "brand_profile_id")
  REFERENCES "creative_projects"("id", "owner_id", "brand_profile_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_composition_scope_fkey"
  FOREIGN KEY ("composition_id", "owner_id", "brand_profile_id", "project_id")
  REFERENCES "creative_compositions"("id", "owner_id", "brand_profile_id", "project_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_exact_composition_version_fkey"
  FOREIGN KEY ("composition_version_id", "composition_id", "composition_version", "composition_document_hash")
  REFERENCES "creative_composition_versions"("id", "composition_id", "version", "document_hash")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_operation_batch_fkey"
  FOREIGN KEY ("operation_batch_id", "composition_id", "composition_version")
  REFERENCES "creative_operation_batches"("id", "composition_id", "result_version")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_source_artifact_version_id_fkey"
  FOREIGN KEY ("source_artifact_version_id") REFERENCES "creative_asset_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_approved_review_event_id_fkey"
  FOREIGN KEY ("approved_review_event_id") REFERENCES "creative_asset_review_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_approved_artifact_version_id_fkey"
  FOREIGN KEY ("approved_artifact_version_id") REFERENCES "creative_asset_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_result_artifact_version_id_fkey"
  FOREIGN KEY ("result_artifact_version_id") REFERENCES "creative_asset_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_jobs_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_lifecycle_receipts"
  ADD CONSTRAINT "creative_lifecycle_receipts_artifact_version_id_fkey"
  FOREIGN KEY ("artifact_version_id") REFERENCES "creative_asset_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_lifecycle_audit_events"
  ADD CONSTRAINT "creative_lifecycle_audit_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_compositions"
  ADD CONSTRAINT "creative_compositions_brand_scope_fkey"
  FOREIGN KEY ("brand_profile_id", "owner_id")
  REFERENCES "creative_brand_profiles"("id", "owner_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "creative_compositions_project_scope_fkey"
  FOREIGN KEY ("project_id", "owner_id", "brand_profile_id")
  REFERENCES "creative_projects"("id", "owner_id", "brand_profile_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "creative_lifecycle_feature_flags"
  ADD CONSTRAINT "creative_lifecycle_feature_flags_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_feature_flags_brand_scope_fkey"
  FOREIGN KEY ("brand_profile_id", "owner_id")
  REFERENCES "creative_brand_profiles"("id", "owner_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_feature_flags_project_scope_fkey"
  FOREIGN KEY ("project_id", "owner_id", "brand_profile_id")
  REFERENCES "creative_projects"("id", "owner_id", "brand_profile_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_feature_flags_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_lifecycle_flag_audit_events"
  ADD CONSTRAINT "creative_lifecycle_flag_audit_events_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_flag_audit_events_feature_flag_id_fkey"
  FOREIGN KEY ("feature_flag_id") REFERENCES "creative_lifecycle_feature_flags"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "creative_lifecycle_flag_audit_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_archive_verification_attempts"
  ADD CONSTRAINT "creative_archive_verification_attempts_receipt_id_fkey"
  FOREIGN KEY ("archive_receipt_id") REFERENCES "creative_archive_receipts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_lifecycle_jobs"
  ADD CONSTRAINT "creative_lifecycle_jobs_progress_check"
  CHECK ("estimated_cost_bdt" >= 0 AND "progress_completed" >= 0
    AND "progress_total" > 0 AND "progress_completed" <= "progress_total"
    AND "attempts" >= 0),
  ADD CONSTRAINT "creative_lifecycle_jobs_paid_effect_check"
  CHECK (NOT "paid_execution_allowed" OR "effect_class" = 'PAID'),
  ADD CONSTRAINT "creative_lifecycle_jobs_review_pin_check"
  CHECK (
    ("approved_review_event_id" IS NULL
      AND "approved_artifact_version_id" IS NULL
      AND "review_fingerprint" IS NULL)
    OR
    ("approved_review_event_id" IS NOT NULL
      AND "approved_artifact_version_id" = "source_artifact_version_id"
      AND "review_fingerprint" ~ '^[a-f0-9]{64}$')
  ),
  ADD CONSTRAINT "creative_lifecycle_jobs_export_review_check"
  CHECK (
    "kind" <> 'EXPORT'
    OR (
      "approved_review_event_id" IS NOT NULL
      AND "approved_artifact_version_id" IS NOT NULL
      AND "review_fingerprint" ~ '^[a-f0-9]{64}$'
    )
  ),
  ADD CONSTRAINT "creative_lifecycle_jobs_fingerprint_check"
  CHECK (
    "render_fingerprint" ~ '^[a-f0-9]{64}$'
    AND "request_fingerprint" ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT "creative_lifecycle_jobs_source_evidence_check"
  CHECK (
    length("source_storage_path") > 0
    AND "source_checksum" ~ '^[a-f0-9]{64}$'
    AND "source_bytes" > 0
  ),
  ADD CONSTRAINT "creative_lifecycle_jobs_ready_artifact_check"
  CHECK ("status" <> 'READY' OR (
    "result_storage_path" IS NOT NULL
    AND "result_checksum" ~ '^[a-f0-9]{64}$'
    AND "result_bytes" > 0
    AND "result_artifact_version_id" IS NOT NULL
    AND "verified_at" IS NOT NULL
  ));
ALTER TABLE "creative_lifecycle_receipts"
  ADD CONSTRAINT "creative_lifecycle_receipts_size_check"
  CHECK ("size_bytes" IS NULL OR "size_bytes" > 0),
  ADD CONSTRAINT "creative_lifecycle_receipts_ready_artifact_check"
  CHECK ("status" <> 'READY' OR (
    "artifact_verified" = true
    AND "artifact_version_id" IS NOT NULL
    AND "storage_path" IS NOT NULL
    AND "checksum" ~ '^[a-f0-9]{64}$'
    AND "size_bytes" > 0
    AND "operation_package_checksum" ~ '^[a-f0-9]{64}$'
    AND "render_storage_path" = "storage_path"
  ));
ALTER TABLE "creative_lifecycle_feature_flags"
  ADD CONSTRAINT "creative_lifecycle_feature_flags_canary_check"
  CHECK ("canary_percent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "creative_lifecycle_feature_flags_scope_check"
  CHECK ("project_id" IS NULL OR "brand_profile_id" IS NOT NULL),
  ADD CONSTRAINT "creative_lifecycle_feature_flags_capability_check"
  CHECK ("capability" IN ('preview', 'render', 'export', 'dry_run', 'schedule', 'live_publish'));
ALTER TABLE "creative_asset_review_events"
  ADD CONSTRAINT "creative_asset_review_events_composition_pin_check"
  CHECK (
    ("composition_id" IS NULL AND "composition_version_id" IS NULL
      AND "composition_version" IS NULL AND "composition_document_hash" IS NULL)
    OR
    ("composition_id" IS NOT NULL AND "composition_version_id" IS NOT NULL
      AND "composition_version" > 0 AND "composition_document_hash" IS NOT NULL
      AND "approved_artifact_version_id" IS NOT NULL AND "to_state" = 'APPROVED')
  ) NOT VALID;
ALTER TABLE "creative_publish_deliveries"
  ADD CONSTRAINT "creative_publish_deliveries_composition_pin_check"
  CHECK (
    ("composition_id" IS NULL AND "composition_version_id" IS NULL
      AND "composition_version" IS NULL AND "composition_document_hash" IS NULL
      AND "operation_batch_id" IS NULL AND "review_fingerprint" IS NULL
      AND "render_fingerprint" IS NULL)
    OR
    ("composition_id" IS NOT NULL AND "composition_version_id" IS NOT NULL
      AND "composition_version" > 0
      AND "composition_document_hash" ~ '^[a-f0-9]{64}$')
  ) NOT VALID;
ALTER TABLE "creative_performance_snapshots"
  ADD CONSTRAINT "creative_performance_snapshots_composition_pin_check"
  CHECK (
    ("composition_id" IS NULL AND "composition_version_id" IS NULL
      AND "composition_version" IS NULL AND "composition_document_hash" IS NULL
      AND "operation_batch_id" IS NULL AND "review_fingerprint" IS NULL
      AND "render_fingerprint" IS NULL)
    OR
    ("composition_id" IS NOT NULL AND "composition_version_id" IS NOT NULL
      AND "composition_version" > 0
      AND "composition_document_hash" ~ '^[a-f0-9]{64}$')
  ) NOT VALID;
ALTER TABLE "creative_archive_receipts"
  ADD CONSTRAINT "creative_archive_receipts_composition_pin_check"
  CHECK (
    (
      ("composition_id" IS NULL AND "composition_version_id" IS NULL
        AND "composition_version" IS NULL AND "composition_document_hash" IS NULL
        AND "operation_batch_id" IS NULL AND "operation_package_checksum" IS NULL)
      OR
      ("composition_id" IS NOT NULL AND "composition_version_id" IS NOT NULL
        AND "composition_version" > 0
        AND "composition_document_hash" ~ '^[a-f0-9]{64}$'
        AND "operation_package_checksum" ~ '^[a-f0-9]{64}$'
        AND "original_storage_path" IS NOT NULL
        AND "render_storage_path" IS NOT NULL)
    )
    AND (
      ("fetch_back_verified_at" IS NULL
        AND ("artifact_checksum" IS NULL OR "artifact_checksum" ~ '^[a-f0-9]{64}$')
        AND ("archive_checksum" IS NULL OR "archive_checksum" ~ '^[a-f0-9]{64}$')
        AND ("fetch_back_checksum" IS NULL OR "fetch_back_checksum" ~ '^[a-f0-9]{64}$'))
      OR
      ("fetch_back_verified_at" IS NOT NULL
        AND "artifact_checksum" ~ '^[a-f0-9]{64}$'
        AND "archive_checksum" = "artifact_checksum"
        AND "fetch_back_checksum" = "artifact_checksum"
        AND "verified_at" IS NOT NULL)
    )
  ) NOT VALID,
  ADD CONSTRAINT "creative_archive_receipts_attempts_check"
  CHECK ("attempts" >= 0) NOT VALID;

-- READY is a relational assertion, not a worker-supplied status. The immutable
-- asset version must be persisted in the exact project/brand and carry the
-- complete job/composition/batch/source/review/render lineage written by the
-- app transaction.
CREATE OR REPLACE FUNCTION "creative_lifecycle_ready_receipt_validate"()
RETURNS trigger AS $$
DECLARE
  evidence record;
  lineage jsonb;
BEGIN
  IF NEW."status" <> 'READY' THEN
    RETURN NEW;
  END IF;

  SELECT
    j."owner_id" AS job_owner_id,
    j."brand_profile_id" AS job_brand_profile_id,
    j."project_id" AS job_project_id,
    j."composition_id" AS job_composition_id,
    j."composition_version_id" AS job_composition_version_id,
    j."composition_version" AS job_composition_version,
    j."composition_document_hash" AS job_composition_document_hash,
    j."operation_batch_id" AS job_operation_batch_id,
    j."source_artifact_version_id" AS job_source_artifact_version_id,
    j."approved_review_event_id" AS job_approved_review_event_id,
    j."approved_artifact_version_id" AS job_approved_artifact_version_id,
    j."review_fingerprint" AS job_review_fingerprint,
    j."render_fingerprint" AS job_render_fingerprint,
    j."kind" AS job_kind,
    j."status" AS job_status,
    j."result_storage_path" AS job_result_storage_path,
    j."result_checksum" AS job_result_checksum,
    j."result_bytes" AS job_result_bytes,
    j."result_artifact_version_id" AS job_result_artifact_version_id,
    j."verified_at" AS job_verified_at,
    v."storage_path" AS artifact_storage_path,
    v."job_id" AS artifact_job_id,
    v."cost_bdt" AS artifact_cost_bdt,
    v."metadata" AS artifact_metadata,
    a."project_id" AS artifact_project_id,
    p."owner_id" AS artifact_owner_id,
    p."brand_profile_id" AS artifact_brand_profile_id
  INTO evidence
  FROM "creative_lifecycle_jobs" j
  JOIN "creative_asset_versions" v ON v."id" = NEW."artifact_version_id"
  JOIN "creative_project_assets" a ON a."id" = v."asset_id"
  JOIN "creative_projects" p ON p."id" = a."project_id"
  WHERE j."id" = NEW."job_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle READY artifact evidence missing';
  END IF;
  lineage := evidence.artifact_metadata -> 'lifecycle';
  IF
    evidence.artifact_project_id IS DISTINCT FROM evidence.job_project_id
    OR evidence.artifact_owner_id IS DISTINCT FROM evidence.job_owner_id
    OR evidence.artifact_brand_profile_id IS DISTINCT FROM evidence.job_brand_profile_id
    OR evidence.job_status IS DISTINCT FROM 'READY'::"CreativeLifecycleJobStatus"
    OR evidence.job_result_storage_path IS DISTINCT FROM NEW."storage_path"
    OR evidence.job_result_checksum IS DISTINCT FROM NEW."checksum"
    OR evidence.job_result_bytes IS DISTINCT FROM NEW."size_bytes"
    OR evidence.job_result_artifact_version_id IS DISTINCT FROM NEW."artifact_version_id"
    OR evidence.job_verified_at IS NULL
    OR evidence.artifact_job_id IS DISTINCT FROM NEW."job_id"
    OR evidence.artifact_storage_path IS DISTINCT FROM NEW."storage_path"
    OR evidence.artifact_cost_bdt < 0
    OR evidence.artifact_metadata ->> 'checksumSha256' IS DISTINCT FROM NEW."checksum"
    OR (evidence.artifact_metadata ->> 'byteSize')::bigint IS DISTINCT FROM NEW."size_bytes"
    OR lineage ->> 'jobId' IS DISTINCT FROM NEW."job_id"
    OR lineage ->> 'ownerId' IS DISTINCT FROM evidence.job_owner_id
    OR lineage ->> 'brandProfileId' IS DISTINCT FROM evidence.job_brand_profile_id
    OR lineage ->> 'projectId' IS DISTINCT FROM evidence.job_project_id
    OR lineage ->> 'compositionId' IS DISTINCT FROM evidence.job_composition_id
    OR lineage ->> 'compositionVersionId' IS DISTINCT FROM evidence.job_composition_version_id
    OR (lineage ->> 'compositionVersion')::integer IS DISTINCT FROM evidence.job_composition_version
    OR lineage ->> 'compositionDocumentHash' IS DISTINCT FROM evidence.job_composition_document_hash
    OR lineage ->> 'operationBatchId' IS DISTINCT FROM evidence.job_operation_batch_id
    OR lineage ->> 'sourceArtifactVersionId' IS DISTINCT FROM evidence.job_source_artifact_version_id
    OR lineage ->> 'approvedReviewEventId' IS DISTINCT FROM evidence.job_approved_review_event_id
    OR lineage ->> 'approvedArtifactVersionId' IS DISTINCT FROM evidence.job_approved_artifact_version_id
    OR lineage ->> 'reviewFingerprint' IS DISTINCT FROM evidence.job_review_fingerprint
    OR lineage ->> 'renderFingerprint' IS DISTINCT FROM evidence.job_render_fingerprint
    OR lineage ->> 'operationPackageChecksum' IS DISTINCT FROM NEW."operation_package_checksum"
    OR lineage ->> 'playableProxyPath' IS DISTINCT FROM NEW."playable_proxy_path"
    OR lineage ->> 'originalStoragePath' IS DISTINCT FROM NEW."original_storage_path"
    OR lineage ->> 'renderStoragePath' IS DISTINCT FROM NEW."render_storage_path"
    OR NEW."composition_document_hash" IS DISTINCT FROM evidence.job_composition_document_hash
    OR NEW."render_storage_path" IS DISTINCT FROM NEW."storage_path"
    OR NOT EXISTS (
      SELECT 1
      FROM "creative_asset_lineage" l
      JOIN "creative_asset_versions" source_version
        ON source_version."id" = evidence.job_source_artifact_version_id
      WHERE l."version_id" = NEW."artifact_version_id"
        AND l."source_asset_id" = source_version."asset_id"
        AND l."relation_kind" = 'lifecycle_' || lower(evidence.job_kind::text)
    )
  THEN
    RAISE EXCEPTION 'lifecycle READY artifact lineage mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "creative_lifecycle_ready_receipt_validate"
BEFORE INSERT ON "creative_lifecycle_receipts"
FOR EACH ROW EXECUTE FUNCTION "creative_lifecycle_ready_receipt_validate"();

CREATE OR REPLACE FUNCTION "creative_lifecycle_job_pin_validate"()
RETURNS trigger AS $$
DECLARE
  source_evidence record;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD."composition_id" IS DISTINCT FROM NEW."composition_id"
    OR OLD."composition_version_id" IS DISTINCT FROM NEW."composition_version_id"
    OR OLD."composition_version" IS DISTINCT FROM NEW."composition_version"
    OR OLD."composition_document_hash" IS DISTINCT FROM NEW."composition_document_hash"
    OR OLD."operation_batch_id" IS DISTINCT FROM NEW."operation_batch_id"
    OR OLD."source_artifact_version_id" IS DISTINCT FROM NEW."source_artifact_version_id"
    OR OLD."source_storage_path" IS DISTINCT FROM NEW."source_storage_path"
    OR OLD."source_checksum" IS DISTINCT FROM NEW."source_checksum"
    OR OLD."source_bytes" IS DISTINCT FROM NEW."source_bytes"
    OR OLD."approved_review_event_id" IS DISTINCT FROM NEW."approved_review_event_id"
    OR OLD."approved_artifact_version_id" IS DISTINCT FROM NEW."approved_artifact_version_id"
    OR OLD."review_fingerprint" IS DISTINCT FROM NEW."review_fingerprint"
  ) THEN
    RAISE EXCEPTION 'creative lifecycle execution pins are immutable';
  END IF;

  SELECT
    v."asset_id",
    v."version" AS source_version,
    v."storage_path" AS source_storage_path,
    v."metadata" ->> 'checksumSha256' AS source_checksum,
    (v."metadata" ->> 'byteSize')::bigint AS source_bytes,
    a."project_id",
    a."review_state",
    a."review_sequence"
  INTO source_evidence
  FROM "creative_asset_versions" v
  JOIN "creative_project_assets" a ON a."id" = v."asset_id"
  WHERE v."id" = NEW."source_artifact_version_id";

  IF NOT FOUND
    OR source_evidence.project_id IS DISTINCT FROM NEW."project_id"
    OR source_evidence.source_storage_path IS DISTINCT FROM NEW."source_storage_path"
    OR source_evidence.source_checksum IS DISTINCT FROM NEW."source_checksum"
    OR source_evidence.source_bytes IS DISTINCT FROM NEW."source_bytes"
    OR source_evidence.source_version IS DISTINCT FROM (
      SELECT max(latest."version")
      FROM "creative_asset_versions" latest
      WHERE latest."asset_id" = source_evidence.asset_id
    )
    OR NOT EXISTS (
      SELECT 1
      FROM "creative_composition_nodes" n
      WHERE n."composition_version_id" = NEW."composition_version_id"
        AND n."asset_version_id" = NEW."source_artifact_version_id"
    )
  THEN
    RAISE EXCEPTION 'lifecycle source artifact is not the exact current composition node';
  END IF;

  IF NEW."operation_batch_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "creative_operation_batches" b
    WHERE b."id" = NEW."operation_batch_id"
      AND b."composition_id" = NEW."composition_id"
      AND b."result_version" = NEW."composition_version"
  ) THEN
    RAISE EXCEPTION 'lifecycle operation batch does not produce the pinned composition version';
  END IF;

  IF NEW."approved_review_event_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "creative_asset_review_events" e
    WHERE e."id" = NEW."approved_review_event_id"
      AND e."asset_id" = source_evidence.asset_id
      AND e."sequence" = source_evidence.review_sequence
      AND source_evidence.review_state = 'APPROVED'
      AND e."to_state" = 'APPROVED'
      AND e."approved_artifact_version_id" = NEW."source_artifact_version_id"
      AND e."composition_id" = NEW."composition_id"
      AND e."composition_version_id" = NEW."composition_version_id"
      AND e."composition_version" = NEW."composition_version"
      AND e."composition_document_hash" = NEW."composition_document_hash"
  ) THEN
    RAISE EXCEPTION 'lifecycle approval is not the authoritative current approval';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "creative_lifecycle_job_pin_validate"
BEFORE INSERT OR UPDATE OF
  "composition_id",
  "composition_version_id",
  "composition_version",
  "composition_document_hash",
  "operation_batch_id",
  "source_artifact_version_id",
  "source_storage_path",
  "source_checksum",
  "source_bytes",
  "approved_review_event_id",
  "approved_artifact_version_id",
  "review_fingerprint"
ON "creative_lifecycle_jobs"
FOR EACH ROW EXECUTE FUNCTION "creative_lifecycle_job_pin_validate"();

CREATE OR REPLACE FUNCTION "creative_lifecycle_ready_evidence_consistency"()
RETURNS trigger AS $$
DECLARE
  evidence_job_id text;
  evidence_job record;
  ready_receipt_count integer;
BEGIN
  evidence_job_id := CASE
    WHEN TG_TABLE_NAME = 'creative_lifecycle_jobs' THEN NEW."id"
    ELSE NEW."job_id"
  END;
  SELECT * INTO evidence_job
  FROM "creative_lifecycle_jobs"
  WHERE "id" = evidence_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle job evidence missing';
  END IF;
  SELECT count(*) INTO ready_receipt_count
  FROM "creative_lifecycle_receipts"
  WHERE "job_id" = evidence_job_id AND "status" = 'READY';

  IF evidence_job."status" = 'READY' THEN
    IF ready_receipt_count <> 1 OR NOT EXISTS (
      SELECT 1
      FROM "creative_lifecycle_receipts" r
      WHERE r."job_id" = evidence_job_id
        AND r."status" = 'READY'
        AND r."artifact_version_id" = evidence_job."result_artifact_version_id"
        AND r."storage_path" = evidence_job."result_storage_path"
        AND r."checksum" = evidence_job."result_checksum"
        AND r."size_bytes" = evidence_job."result_bytes"
        AND r."artifact_verified" = true
    ) THEN
      RAISE EXCEPTION 'lifecycle READY job requires exactly one matching READY receipt';
    END IF;
  ELSIF ready_receipt_count <> 0 THEN
    RAISE EXCEPTION 'lifecycle READY receipt requires a READY job';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "creative_lifecycle_job_ready_evidence_consistency"
AFTER INSERT OR UPDATE ON "creative_lifecycle_jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "creative_lifecycle_ready_evidence_consistency"();
CREATE CONSTRAINT TRIGGER "creative_lifecycle_receipt_ready_evidence_consistency"
AFTER INSERT ON "creative_lifecycle_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "creative_lifecycle_ready_evidence_consistency"();

CREATE OR REPLACE FUNCTION "creative_lifecycle_ready_job_immutable"()
RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'READY' THEN
    RAISE EXCEPTION 'creative lifecycle READY job evidence is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "creative_lifecycle_ready_job_immutable"
BEFORE UPDATE OR DELETE ON "creative_lifecycle_jobs"
FOR EACH ROW EXECUTE FUNCTION "creative_lifecycle_ready_job_immutable"();

CREATE OR REPLACE FUNCTION "creative_lifecycle_result_artifact_immutable"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "creative_lifecycle_jobs"
    WHERE "result_artifact_version_id" = OLD."id"
       OR "source_artifact_version_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'creative lifecycle source/result artifact version is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "creative_lifecycle_result_artifact_immutable"
BEFORE UPDATE OR DELETE ON "creative_asset_versions"
FOR EACH ROW EXECUTE FUNCTION "creative_lifecycle_result_artifact_immutable"();

-- Existing CSE6/CSE7 rows intentionally remain NULL and retain legacy fallback.
-- Audit and receipt evidence is append-only.
CREATE TRIGGER "creative_lifecycle_receipts_append_only"
BEFORE UPDATE OR DELETE ON "creative_lifecycle_receipts"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();
CREATE TRIGGER "creative_lifecycle_audit_events_append_only"
BEFORE UPDATE OR DELETE ON "creative_lifecycle_audit_events"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();
CREATE TRIGGER "creative_lifecycle_flag_audit_events_append_only"
BEFORE UPDATE OR DELETE ON "creative_lifecycle_flag_audit_events"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();
CREATE TRIGGER "creative_archive_verification_attempts_append_only"
BEFORE UPDATE OR DELETE ON "creative_archive_verification_attempts"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();

COMMIT;
