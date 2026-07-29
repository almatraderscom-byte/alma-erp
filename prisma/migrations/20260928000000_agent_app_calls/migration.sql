-- Agent → owner in-app VoIP call (additive).
CREATE TABLE "agent_app_calls" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ladder',
    "status" TEXT NOT NULL DEFAULT 'ringing',
    "push_result" JSONB,
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_app_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_app_calls_status_created_at_idx" ON "agent_app_calls"("status", "created_at");

-- Ladder stage-0 pointer (additive).
ALTER TABLE "agent_call_escalations" ADD COLUMN "app_call_id" TEXT;
