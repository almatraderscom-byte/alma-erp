-- Roadmap 1 Phase 32 — Conversation Focus + Continuation spine. Additive only.
CREATE TABLE "agent_conversation_focuses" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "status" TEXT NOT NULL DEFAULT 'active',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "goal" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "workflow_run_id" TEXT,
    "checkpoint_task_ref" TEXT,
    "open_task_id" TEXT,
    "pending_action_id" TEXT,
    "ask_card_id" TEXT,
    "current_step" TEXT,
    "completed_steps" JSONB,
    "last_effect_id" TEXT,
    "last_error_class" TEXT,
    "blocker" TEXT,
    "next_actions" JSONB,
    "completion_criteria" TEXT,
    "artifacts" JSONB,
    "surface" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lease_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "agent_conversation_focuses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_conversation_focuses_conversation_id_status_updated_a_idx"
    ON "agent_conversation_focuses"("conversation_id", "status", "updated_at");
CREATE INDEX "agent_conversation_focuses_workflow_run_id_idx"
    ON "agent_conversation_focuses"("workflow_run_id");

CREATE TABLE "agent_focus_events" (
    "id" TEXT NOT NULL,
    "focus_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "version" INTEGER NOT NULL,
    "cause" TEXT NOT NULL DEFAULT 'turn',
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_focus_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_focus_events_focus_id_created_at_idx"
    ON "agent_focus_events"("focus_id", "created_at");
CREATE INDEX "agent_focus_events_conversation_id_created_at_idx"
    ON "agent_focus_events"("conversation_id", "created_at");
