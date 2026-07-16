-- Phase 44 — growth experiment registry (agent_growth_experiments). Every
-- marketing asset belongs to an experiment with hypothesis + stop/scale rules.
-- Additive only.
CREATE TABLE "agent_growth_experiments" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "hypothesis" JSONB NOT NULL,
    "briefVersion" INTEGER,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "outcome" JSONB,
    "learning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_growth_experiments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_growth_experiments_businessId_status_idx" ON "agent_growth_experiments"("businessId", "status");
