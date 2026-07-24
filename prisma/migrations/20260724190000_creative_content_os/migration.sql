-- CSE3 — ALMA Content OS
-- Additive owner-scoped project, brand recipe, asset version, lineage and tag
-- records. Existing Creative Studio jobs remain untouched and surface through
-- the read-only Legacy collection at the application layer.

CREATE TABLE "creative_brand_profiles" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "organization" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creative_brand_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_brand_profiles_owner_id_name_key"
  ON "creative_brand_profiles"("owner_id", "name");
CREATE INDEX "creative_brand_profiles_owner_id_updated_at_idx"
  ON "creative_brand_profiles"("owner_id", "updated_at" DESC);

CREATE TABLE "creative_brand_recipes" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "brand_profile_id" TEXT NOT NULL,
  "recipe_key" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "name" TEXT NOT NULL,
  "scene_subset" JSONB NOT NULL DEFAULT '[]',
  "model_roles" JSONB NOT NULL DEFAULT '[]',
  "finish_theme" TEXT NOT NULL DEFAULT 'default',
  "caption_tone" TEXT NOT NULL DEFAULT 'premium',
  "aspect_pack" JSONB NOT NULL DEFAULT '["4:5"]',
  "music_vibe" TEXT NOT NULL DEFAULT 'premium',
  "qc_level" TEXT NOT NULL DEFAULT 'strict',
  "spend_ceiling_bdt" INTEGER NOT NULL DEFAULT 0,
  "locked_at" TIMESTAMP(3),
  "locked_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creative_brand_recipes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creative_brand_recipes_brand_profile_id_fkey"
    FOREIGN KEY ("brand_profile_id") REFERENCES "creative_brand_profiles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "creative_brand_recipes_brand_profile_id_recipe_key_version_key"
  ON "creative_brand_recipes"("brand_profile_id", "recipe_key", "version");
CREATE INDEX "creative_brand_recipes_owner_id_updated_at_idx"
  ON "creative_brand_recipes"("owner_id", "updated_at" DESC);
CREATE INDEX "creative_brand_recipes_brand_profile_id_recipe_key_version_idx"
  ON "creative_brand_recipes"("brand_profile_id", "recipe_key", "version" DESC);

CREATE TABLE "creative_projects" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "brand_profile_id" TEXT,
  "current_recipe_id" TEXT,
  "product_code" TEXT,
  "product_name" TEXT,
  "product_price_bdt" INTEGER,
  "product_source_image" TEXT,
  "default_folder" TEXT NOT NULL DEFAULT 'Unsorted',
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creative_projects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creative_projects_brand_profile_id_fkey"
    FOREIGN KEY ("brand_profile_id") REFERENCES "creative_brand_profiles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "creative_projects_current_recipe_id_fkey"
    FOREIGN KEY ("current_recipe_id") REFERENCES "creative_brand_recipes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "creative_projects_owner_id_archived_at_updated_at_idx"
  ON "creative_projects"("owner_id", "archived_at", "updated_at" DESC);
CREATE INDEX "creative_projects_brand_profile_id_idx"
  ON "creative_projects"("brand_profile_id");
CREATE INDEX "creative_projects_current_recipe_id_idx"
  ON "creative_projects"("current_recipe_id");

CREATE TABLE "creative_project_assets" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "pending_action_id" TEXT,
  "asset_type" TEXT NOT NULL DEFAULT 'image',
  "title" TEXT,
  "folder" TEXT NOT NULL DEFAULT 'Unsorted',
  "latest_storage_path" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "creative_project_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creative_project_assets_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "creative_projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "creative_project_assets_project_id_pending_action_id_key"
  ON "creative_project_assets"("project_id", "pending_action_id");
CREATE INDEX "creative_project_assets_project_id_folder_updated_at_idx"
  ON "creative_project_assets"("project_id", "folder", "updated_at" DESC);
CREATE INDEX "creative_project_assets_pending_action_id_idx"
  ON "creative_project_assets"("pending_action_id");
CREATE INDEX "creative_project_assets_created_by_id_idx"
  ON "creative_project_assets"("created_by_id");

CREATE TABLE "creative_asset_versions" (
  "id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "storage_path" TEXT,
  "recipe_id" TEXT,
  "recipe_version" INTEGER,
  "provider" TEXT,
  "engine" TEXT,
  "job_id" TEXT,
  "cost_bdt" INTEGER NOT NULL DEFAULT 0,
  "cost_usd" DECIMAL(12,6),
  "qc" JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creative_asset_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creative_asset_versions_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "creative_project_assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creative_asset_versions_recipe_id_fkey"
    FOREIGN KEY ("recipe_id") REFERENCES "creative_brand_recipes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "creative_asset_versions_asset_id_version_key"
  ON "creative_asset_versions"("asset_id", "version");
CREATE INDEX "creative_asset_versions_recipe_id_idx"
  ON "creative_asset_versions"("recipe_id");
CREATE INDEX "creative_asset_versions_job_id_idx"
  ON "creative_asset_versions"("job_id");

CREATE TABLE "creative_asset_lineage" (
  "id" TEXT NOT NULL,
  "version_id" TEXT NOT NULL,
  "source_asset_id" TEXT NOT NULL,
  "relation_kind" TEXT NOT NULL DEFAULT 'derived_from',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creative_asset_lineage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creative_asset_lineage_version_id_fkey"
    FOREIGN KEY ("version_id") REFERENCES "creative_asset_versions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creative_asset_lineage_source_asset_id_fkey"
    FOREIGN KEY ("source_asset_id") REFERENCES "creative_project_assets"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "creative_asset_lineage_version_id_source_asset_id_relation_kind_key"
  ON "creative_asset_lineage"("version_id", "source_asset_id", "relation_kind");
CREATE INDEX "creative_asset_lineage_source_asset_id_idx"
  ON "creative_asset_lineage"("source_asset_id");

CREATE TABLE "creative_asset_tags" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT 'clay',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "creative_asset_tags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_asset_tags_owner_id_slug_key"
  ON "creative_asset_tags"("owner_id", "slug");
CREATE INDEX "creative_asset_tags_owner_id_name_idx"
  ON "creative_asset_tags"("owner_id", "name");

CREATE TABLE "creative_project_asset_tags" (
  "asset_id" TEXT NOT NULL,
  "tag_id" TEXT NOT NULL,
  CONSTRAINT "creative_project_asset_tags_pkey" PRIMARY KEY ("asset_id", "tag_id"),
  CONSTRAINT "creative_project_asset_tags_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "creative_project_assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creative_project_asset_tags_tag_id_fkey"
    FOREIGN KEY ("tag_id") REFERENCES "creative_asset_tags"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "creative_project_asset_tags_tag_id_idx"
  ON "creative_project_asset_tags"("tag_id");
