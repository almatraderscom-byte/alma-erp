-- Artifact version history (2026-07-16 owner ask: Claude-app-style artifact
-- panel). Until now a same-title save UPDATED the row in place and the old
-- content was lost; from now the previous body is snapshotted here first.
-- Additive only.
CREATE TABLE "agent_artifact_versions" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT,
    "title" TEXT,
    "content" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_artifact_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_artifact_versions_artifactId_idx" ON "agent_artifact_versions"("artifactId");

CREATE UNIQUE INDEX "agent_artifact_versions_artifactId_version_key" ON "agent_artifact_versions"("artifactId", "version");

ALTER TABLE "agent_artifact_versions"
    ADD CONSTRAINT "agent_artifact_versions_artifactId_fkey"
    FOREIGN KEY ("artifactId") REFERENCES "agent_artifacts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
