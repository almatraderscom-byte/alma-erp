-- PA-2 proactive-call escalation ladder (additive). One row per "call the owner"
-- cause; the /api/cron/call-escalations cron walks each row through
-- WhatsApp call → PSTN call → summary push.
CREATE TABLE "agent_call_escalations" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "approval_action_id" TEXT,
    "wa_call_id" TEXT,
    "pstn_call_id" TEXT,
    "first_call_at" TIMESTAMP(3),
    "next_check_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "agent_call_escalations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_call_escalations_status_next_check_at_idx" ON "agent_call_escalations"("status", "next_check_at");
CREATE INDEX "agent_call_escalations_ref_id_status_idx" ON "agent_call_escalations"("ref_id", "status");
CREATE INDEX "agent_call_escalations_first_call_at_idx" ON "agent_call_escalations"("first_call_at");
