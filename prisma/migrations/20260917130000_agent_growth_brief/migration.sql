-- Phase 42 — versioned Growth Brain (agent_growth_briefs). One row per brief
-- VERSION; history preserved; one approved row per business at a time.
-- Additive only.
CREATE TABLE "agent_growth_briefs" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "brief" JSONB NOT NULL,
    "changeReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_growth_briefs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_growth_briefs_businessId_version_key" ON "agent_growth_briefs"("businessId", "version");

CREATE INDEX "agent_growth_briefs_businessId_status_idx" ON "agent_growth_briefs"("businessId", "status");
