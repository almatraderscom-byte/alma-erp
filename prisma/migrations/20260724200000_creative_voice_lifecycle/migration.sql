-- CSE5: durable, owner-scoped cloned-voice lifecycle.
-- Additive only. Provider identities and consent rows are never hard-deleted.

CREATE TABLE "creative_voices" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'elevenlabs',
    "owner_only" BOOLEAN NOT NULL DEFAULT true,
    "active_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "creative_voices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_voice_versions" (
    "id" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "provider_voice_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "consent_recorded_at" TIMESTAMP(3) NOT NULL,
    "consent_statement" TEXT NOT NULL,
    "consent_sha256" TEXT NOT NULL,
    "sample_paths" JSONB NOT NULL DEFAULT '[]',
    "activated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "provider_deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_voice_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "creative_voice_audits" (
    "id" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "voice_version_id" TEXT,
    "owner_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'elevenlabs',
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creative_voice_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creative_voices_owner_id_name_key" ON "creative_voices"("owner_id", "name");
CREATE UNIQUE INDEX "creative_voices_active_version_id_key" ON "creative_voices"("active_version_id");
CREATE INDEX "creative_voices_owner_id_updated_at_idx" ON "creative_voices"("owner_id", "updated_at" DESC);

CREATE UNIQUE INDEX "creative_voice_versions_voice_id_version_key" ON "creative_voice_versions"("voice_id", "version");
CREATE UNIQUE INDEX "creative_voice_versions_voice_id_provider_voice_id_key" ON "creative_voice_versions"("voice_id", "provider_voice_id");
CREATE INDEX "creative_voice_versions_voice_id_created_at_idx" ON "creative_voice_versions"("voice_id", "created_at" DESC);
CREATE INDEX "creative_voice_versions_status_idx" ON "creative_voice_versions"("status");

CREATE INDEX "creative_voice_audits_voice_id_created_at_idx" ON "creative_voice_audits"("voice_id", "created_at" DESC);
CREATE INDEX "creative_voice_audits_voice_version_id_created_at_idx" ON "creative_voice_audits"("voice_version_id", "created_at" DESC);
CREATE INDEX "creative_voice_audits_owner_id_created_at_idx" ON "creative_voice_audits"("owner_id", "created_at" DESC);

ALTER TABLE "creative_voice_versions"
ADD CONSTRAINT "creative_voice_versions_voice_id_fkey"
FOREIGN KEY ("voice_id") REFERENCES "creative_voices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_voices"
ADD CONSTRAINT "creative_voices_active_version_id_fkey"
FOREIGN KEY ("active_version_id") REFERENCES "creative_voice_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "creative_voice_audits"
ADD CONSTRAINT "creative_voice_audits_voice_id_fkey"
FOREIGN KEY ("voice_id") REFERENCES "creative_voices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "creative_voice_audits"
ADD CONSTRAINT "creative_voice_audits_voice_version_id_fkey"
FOREIGN KEY ("voice_version_id") REFERENCES "creative_voice_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
