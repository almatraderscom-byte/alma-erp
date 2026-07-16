-- Phase 43 — marketing event ledger (agent_marketing_events). Deterministic
-- eventId is the dedup key shared by browser Pixel + server CAPI. Additive only.
CREATE TABLE "agent_marketing_events" (
    "id" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "valueBdt" INTEGER,
    "orderId" TEXT,
    "utm" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_marketing_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_marketing_events_eventId_key" ON "agent_marketing_events"("eventId");

CREATE INDEX "agent_marketing_events_eventName_occurredAt_idx" ON "agent_marketing_events"("eventName", "occurredAt");

CREATE INDEX "agent_marketing_events_orderId_idx" ON "agent_marketing_events"("orderId");

CREATE INDEX "agent_marketing_events_status_createdAt_idx" ON "agent_marketing_events"("status", "createdAt");
