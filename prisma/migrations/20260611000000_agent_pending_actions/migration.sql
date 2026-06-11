-- Phase 4: agent_pending_actions table for confirm-card system
CREATE TABLE "agent_pending_actions" (
    "id"             TEXT NOT NULL,
    "conversationId" TEXT,
    "type"           TEXT NOT NULL,
    "payload"        JSONB NOT NULL,
    "summary"        TEXT NOT NULL,
    "costEstimate"   DOUBLE PRECISION,
    "status"         TEXT NOT NULL DEFAULT 'pending',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"     TIMESTAMP(3),
    "result"         JSONB,
    CONSTRAINT "agent_pending_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_pending_actions_status_idx"         ON "agent_pending_actions"("status");
CREATE INDEX "agent_pending_actions_conversationId_idx" ON "agent_pending_actions"("conversationId");
