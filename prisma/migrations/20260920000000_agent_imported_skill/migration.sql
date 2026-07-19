-- Skill Engine V2 (B4): imported-skill lifecycle store. Additive only.
CREATE TABLE "agent_imported_skills" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source_repo" TEXT NOT NULL,
    "source_commit" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "findings" JSONB,
    "reviewed_by" TEXT,
    "supersedes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_imported_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_imported_skills_name_source_commit_key"
    ON "agent_imported_skills"("name", "source_commit");

CREATE INDEX "agent_imported_skills_name_status_idx"
    ON "agent_imported_skills"("name", "status");
