-- CSE6: brand-scoped Studio roles plus immutable asset review history.
-- Additive only. Existing owner-only behavior remains implicit in application
-- access checks; no existing user receives a collaboration role automatically.

CREATE TYPE "CreativeStudioRole" AS ENUM ('OWNER', 'CREATOR', 'REVIEWER');
CREATE TYPE "CreativeAssetReviewState" AS ENUM ('DRAFT', 'CHANGES_REQUESTED', 'REVISED', 'APPROVED');

ALTER TABLE "creative_brand_profiles"
ADD COLUMN "approval_spend_threshold_bdt" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "creative_project_assets"
ADD COLUMN "review_state" "CreativeAssetReviewState" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN "review_sequence" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "creative_studio_role_assignments" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "brand_profile_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "CreativeStudioRole" NOT NULL,
    "granted_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "creative_studio_role_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_asset_review_comments" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "brand_profile_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_role" "CreativeStudioRole" NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_asset_review_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_asset_review_events" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "brand_profile_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "from_state" "CreativeAssetReviewState",
    "to_state" "CreativeAssetReviewState" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_role" "CreativeStudioRole" NOT NULL,
    "note" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_asset_review_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_studio_role_assignments_brand_profile_id_user_id_key"
ON "creative_studio_role_assignments"("brand_profile_id", "user_id");
CREATE INDEX "creative_studio_role_assignments_owner_id_brand_profile_id_idx"
ON "creative_studio_role_assignments"("owner_id", "brand_profile_id");
CREATE INDEX "creative_studio_role_assignments_user_id_role_idx"
ON "creative_studio_role_assignments"("user_id", "role");

CREATE INDEX "creative_asset_review_comments_asset_id_created_at_idx"
ON "creative_asset_review_comments"("asset_id", "created_at");
CREATE INDEX "creative_asset_review_comments_brand_profile_id_created_at_idx"
ON "creative_asset_review_comments"("brand_profile_id", "created_at");
CREATE INDEX "creative_asset_review_comments_author_id_created_at_idx"
ON "creative_asset_review_comments"("author_id", "created_at");

CREATE UNIQUE INDEX "creative_asset_review_events_asset_id_sequence_key"
ON "creative_asset_review_events"("asset_id", "sequence");
CREATE INDEX "creative_asset_review_events_brand_profile_id_created_at_idx"
ON "creative_asset_review_events"("brand_profile_id", "created_at");
CREATE INDEX "creative_asset_review_events_actor_id_created_at_idx"
ON "creative_asset_review_events"("actor_id", "created_at");

ALTER TABLE "creative_studio_role_assignments"
ADD CONSTRAINT "creative_studio_role_assignments_brand_profile_id_fkey"
FOREIGN KEY ("brand_profile_id") REFERENCES "creative_brand_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_studio_role_assignments"
ADD CONSTRAINT "creative_studio_role_assignments_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_studio_role_assignments"
ADD CONSTRAINT "creative_studio_role_assignments_granted_by_id_fkey"
FOREIGN KEY ("granted_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_asset_review_comments"
ADD CONSTRAINT "creative_asset_review_comments_asset_id_fkey"
FOREIGN KEY ("asset_id") REFERENCES "creative_project_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_asset_review_comments"
ADD CONSTRAINT "creative_asset_review_comments_brand_profile_id_fkey"
FOREIGN KEY ("brand_profile_id") REFERENCES "creative_brand_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_asset_review_comments"
ADD CONSTRAINT "creative_asset_review_comments_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_asset_review_events"
ADD CONSTRAINT "creative_asset_review_events_asset_id_fkey"
FOREIGN KEY ("asset_id") REFERENCES "creative_project_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_asset_review_events"
ADD CONSTRAINT "creative_asset_review_events_brand_profile_id_fkey"
FOREIGN KEY ("brand_profile_id") REFERENCES "creative_brand_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "creative_asset_review_events"
ADD CONSTRAINT "creative_asset_review_events_actor_id_fkey"
FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The collaboration ledger is append-only even if application code regresses.
CREATE OR REPLACE FUNCTION "creative_review_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'creative review history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "creative_asset_review_comments_append_only"
BEFORE UPDATE OR DELETE ON "creative_asset_review_comments"
FOR EACH ROW EXECUTE FUNCTION "creative_review_append_only"();

CREATE TRIGGER "creative_asset_review_events_append_only"
BEFORE UPDATE OR DELETE ON "creative_asset_review_events"
FOR EACH ROW EXECUTE FUNCTION "creative_review_append_only"();
