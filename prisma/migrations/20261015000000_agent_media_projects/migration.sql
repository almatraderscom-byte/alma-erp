-- Media mode (CapCut-class video engine) — M0 foundation tables.
-- Additive only: three new tables, no existing table touched.

CREATE TABLE IF NOT EXISTS "agent_media_projects" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "plan_json" JSONB NOT NULL,
    "plan_revision" INTEGER NOT NULL DEFAULT 0,
    "aspect" TEXT NOT NULL DEFAULT '9:16',
    "language" TEXT NOT NULL DEFAULT 'bn',
    "total_estimate_usd" DOUBLE PRECISION,
    "total_actual_usd" DOUBLE PRECISION,
    "final_asset_path" TEXT,
    "pending_action_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_media_projects_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_media_projects_status_idx" ON "agent_media_projects"("status");
CREATE INDEX IF NOT EXISTS "agent_media_projects_conversation_id_idx" ON "agent_media_projects"("conversation_id");

CREATE TABLE IF NOT EXISTS "agent_media_scenes" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "brief" TEXT NOT NULL,
    "vo_script" TEXT,
    "image_prompt" TEXT,
    "clip_brief" TEXT,
    "duration_sec" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_media_scenes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_media_scenes_project_id_fkey" FOREIGN KEY ("project_id")
      REFERENCES "agent_media_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_media_scenes_project_id_idx_key" ON "agent_media_scenes"("project_id", "idx");

CREATE TABLE IF NOT EXISTS "agent_media_assets" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "scene_id" TEXT,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "job_id" TEXT,
    "storage_path" TEXT,
    "mime_type" TEXT,
    "duration_sec" DOUBLE PRECISION,
    "cost_usd" DOUBLE PRECISION,
    "model_id" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_media_assets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_media_assets_project_id_fkey" FOREIGN KEY ("project_id")
      REFERENCES "agent_media_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "agent_media_assets_project_id_kind_status_idx" ON "agent_media_assets"("project_id", "kind", "status");
CREATE INDEX IF NOT EXISTS "agent_media_assets_scene_id_idx" ON "agent_media_assets"("scene_id");
