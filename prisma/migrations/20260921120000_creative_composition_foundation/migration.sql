-- Creative Studio V3 Phase 1: provider-neutral composition documents and the
-- append-only command/audit ledger. Additive only; legacy Studio tables, routes,
-- workers, generation contracts, reviews, and publishing remain unchanged.

CREATE TYPE "CreativeCompositionSourceKind" AS ENUM ('PROJECT_PROJECTION', 'NATIVE');
CREATE TYPE "CreativeCompositionEffectClass" AS ENUM ('ZERO_COST_LOCAL', 'PAID', 'DESTRUCTIVE', 'EXTERNAL');
CREATE TYPE "CreativeOperationBatchKind" AS ENUM ('CREATE', 'APPLY', 'UNDO', 'REDO', 'ROLLBACK');

CREATE TABLE "creative_compositions" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "brand_profile_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source_kind" "CreativeCompositionSourceKind" NOT NULL DEFAULT 'PROJECT_PROJECTION',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "concurrency_token" TEXT NOT NULL,
    "read_only" BOOLEAN NOT NULL DEFAULT false,
    "creation_idempotency_key" TEXT NOT NULL,
    "creation_request_fingerprint" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "creative_compositions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_operation_batches" (
    "id" TEXT NOT NULL,
    "composition_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "kind" "CreativeOperationBatchKind" NOT NULL,
    "expected_version" INTEGER NOT NULL,
    "result_version" INTEGER NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_role" "CreativeStudioRole" NOT NULL,
    "operation_count" INTEGER NOT NULL,
    "effect_class" "CreativeCompositionEffectClass" NOT NULL DEFAULT 'ZERO_COST_LOCAL',
    "estimated_cost_bdt" INTEGER NOT NULL DEFAULT 0,
    "confirmation_fingerprint" TEXT,
    "target_batch_id" TEXT,
    "target_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_operation_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_composition_versions" (
    "id" TEXT NOT NULL,
    "composition_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "parent_version" INTEGER,
    "document" JSONB NOT NULL,
    "document_hash" TEXT NOT NULL,
    "operation_batch_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_composition_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_composition_nodes" (
    "id" TEXT NOT NULL,
    "composition_version_id" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "node_kind" TEXT NOT NULL,
    "asset_version_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_composition_nodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_edit_operations" (
    "id" TEXT NOT NULL,
    "composition_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "operation_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "inverse" JSONB NOT NULL,
    "before_projection" JSONB,
    "after_projection" JSONB,
    "selection" JSONB,
    "time_range" JSONB,
    "effect_class" "CreativeCompositionEffectClass" NOT NULL DEFAULT 'ZERO_COST_LOCAL',
    "estimated_cost_bdt" INTEGER NOT NULL DEFAULT 0,
    "confirmation_fingerprint" TEXT,
    "job_id" TEXT,
    "actor_id" TEXT NOT NULL,
    "actor_role" "CreativeStudioRole" NOT NULL,
    "expected_version" INTEGER NOT NULL,
    "result_version" INTEGER NOT NULL,
    "audited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_edit_operations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_rollback_points" (
    "id" TEXT NOT NULL,
    "composition_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "source_batch_id" TEXT NOT NULL,
    "label" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_rollback_points_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_compositions_owner_id_creation_idempotency_key_key"
ON "creative_compositions"("owner_id", "creation_idempotency_key");
CREATE INDEX "creative_compositions_brand_profile_id_project_id_updated_at_idx"
ON "creative_compositions"("brand_profile_id", "project_id", "updated_at" DESC);
CREATE INDEX "creative_compositions_owner_id_archived_at_updated_at_idx"
ON "creative_compositions"("owner_id", "archived_at", "updated_at" DESC);

CREATE UNIQUE INDEX "creative_operation_batches_composition_id_idempotency_key_key"
ON "creative_operation_batches"("composition_id", "idempotency_key");
CREATE INDEX "creative_operation_batches_composition_id_result_version_idx"
ON "creative_operation_batches"("composition_id", "result_version" DESC);
CREATE INDEX "creative_operation_batches_actor_id_created_at_idx"
ON "creative_operation_batches"("actor_id", "created_at" DESC);
CREATE INDEX "creative_operation_batches_target_batch_id_idx"
ON "creative_operation_batches"("target_batch_id");

CREATE UNIQUE INDEX "creative_composition_versions_operation_batch_id_key"
ON "creative_composition_versions"("operation_batch_id");
CREATE UNIQUE INDEX "creative_composition_versions_composition_id_version_key"
ON "creative_composition_versions"("composition_id", "version");
CREATE INDEX "creative_composition_versions_composition_id_created_at_idx"
ON "creative_composition_versions"("composition_id", "created_at" DESC);
CREATE INDEX "creative_composition_versions_created_by_id_created_at_idx"
ON "creative_composition_versions"("created_by_id", "created_at" DESC);

CREATE UNIQUE INDEX "creative_composition_nodes_composition_version_id_node_key_key"
ON "creative_composition_nodes"("composition_version_id", "node_key");
CREATE INDEX "creative_composition_nodes_asset_version_id_node_kind_idx"
ON "creative_composition_nodes"("asset_version_id", "node_kind");
CREATE INDEX "creative_composition_nodes_node_kind_created_at_idx"
ON "creative_composition_nodes"("node_kind", "created_at" DESC);

CREATE UNIQUE INDEX "creative_edit_operations_batch_id_sequence_key"
ON "creative_edit_operations"("batch_id", "sequence");
CREATE INDEX "creative_edit_operations_composition_id_audited_at_idx"
ON "creative_edit_operations"("composition_id", "audited_at" DESC);
CREATE INDEX "creative_edit_operations_actor_id_audited_at_idx"
ON "creative_edit_operations"("actor_id", "audited_at" DESC);
CREATE INDEX "creative_edit_operations_job_id_idx"
ON "creative_edit_operations"("job_id");

CREATE UNIQUE INDEX "creative_rollback_points_source_batch_id_key"
ON "creative_rollback_points"("source_batch_id");
CREATE INDEX "creative_rollback_points_composition_id_version_number_idx"
ON "creative_rollback_points"("composition_id", "version_number" DESC);
CREATE INDEX "creative_rollback_points_created_by_id_created_at_idx"
ON "creative_rollback_points"("created_by_id", "created_at" DESC);

ALTER TABLE "creative_compositions"
ADD CONSTRAINT "creative_compositions_brand_profile_id_fkey"
FOREIGN KEY ("brand_profile_id") REFERENCES "creative_brand_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_compositions"
ADD CONSTRAINT "creative_compositions_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "creative_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_compositions"
ADD CONSTRAINT "creative_compositions_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_operation_batches"
ADD CONSTRAINT "creative_operation_batches_composition_id_fkey"
FOREIGN KEY ("composition_id") REFERENCES "creative_compositions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_operation_batches"
ADD CONSTRAINT "creative_operation_batches_actor_id_fkey"
FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_operation_batches"
ADD CONSTRAINT "creative_operation_batches_target_batch_id_fkey"
FOREIGN KEY ("target_batch_id") REFERENCES "creative_operation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_composition_versions"
ADD CONSTRAINT "creative_composition_versions_composition_id_fkey"
FOREIGN KEY ("composition_id") REFERENCES "creative_compositions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_composition_versions"
ADD CONSTRAINT "creative_composition_versions_operation_batch_id_fkey"
FOREIGN KEY ("operation_batch_id") REFERENCES "creative_operation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_composition_versions"
ADD CONSTRAINT "creative_composition_versions_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_composition_nodes"
ADD CONSTRAINT "creative_composition_nodes_composition_version_id_fkey"
FOREIGN KEY ("composition_version_id") REFERENCES "creative_composition_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_composition_nodes"
ADD CONSTRAINT "creative_composition_nodes_asset_version_id_fkey"
FOREIGN KEY ("asset_version_id") REFERENCES "creative_asset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_edit_operations"
ADD CONSTRAINT "creative_edit_operations_composition_id_fkey"
FOREIGN KEY ("composition_id") REFERENCES "creative_compositions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_edit_operations"
ADD CONSTRAINT "creative_edit_operations_batch_id_fkey"
FOREIGN KEY ("batch_id") REFERENCES "creative_operation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_edit_operations"
ADD CONSTRAINT "creative_edit_operations_actor_id_fkey"
FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_rollback_points"
ADD CONSTRAINT "creative_rollback_points_composition_id_fkey"
FOREIGN KEY ("composition_id") REFERENCES "creative_compositions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_rollback_points"
ADD CONSTRAINT "creative_rollback_points_version_id_fkey"
FOREIGN KEY ("version_id") REFERENCES "creative_composition_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_rollback_points"
ADD CONSTRAINT "creative_rollback_points_source_batch_id_fkey"
FOREIGN KEY ("source_batch_id") REFERENCES "creative_operation_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_rollback_points"
ADD CONSTRAINT "creative_rollback_points_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Audit/history rows cannot be rewritten or removed, even if application code
-- regresses. Rollback always appends a new version instead.
CREATE OR REPLACE FUNCTION "creative_composition_history_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'creative composition history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "creative_operation_batches_append_only"
BEFORE UPDATE OR DELETE ON "creative_operation_batches"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();

CREATE TRIGGER "creative_composition_versions_append_only"
BEFORE UPDATE OR DELETE ON "creative_composition_versions"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();

CREATE TRIGGER "creative_composition_nodes_append_only"
BEFORE UPDATE OR DELETE ON "creative_composition_nodes"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();

CREATE TRIGGER "creative_edit_operations_append_only"
BEFORE UPDATE OR DELETE ON "creative_edit_operations"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();

CREATE TRIGGER "creative_rollback_points_append_only"
BEFORE UPDATE OR DELETE ON "creative_rollback_points"
FOR EACH ROW EXECUTE FUNCTION "creative_composition_history_append_only"();
