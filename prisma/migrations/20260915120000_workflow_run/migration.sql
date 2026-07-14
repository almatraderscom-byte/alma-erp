-- Roadmap Phase 4 (AGENT-STATE-001): canonical WorkflowRun — the one record of
-- an in-flight job (goal, status, state, legal next actions) that plans, open
-- tasks, checkpoints and pending actions link to. Additive only.

CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT,
  "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
  "kind" TEXT NOT NULL,
  "goal" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "state" TEXT NOT NULL DEFAULT 'started',
  "state_version" INTEGER NOT NULL DEFAULT 1,
  "inputs" JSONB,
  "facts" JSONB,
  "artifacts" JSONB,
  "next_allowed_tools" JSONB,
  "pending_action_id" TEXT,
  "last_proof" JSONB,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "lease_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "workflow_runs_conversation_id_status_idx"
  ON "workflow_runs"("conversation_id", "status");
CREATE INDEX IF NOT EXISTS "workflow_runs_business_id_status_idx"
  ON "workflow_runs"("business_id", "status");
CREATE INDEX IF NOT EXISTS "workflow_runs_pending_action_id_idx"
  ON "workflow_runs"("pending_action_id");

CREATE TABLE IF NOT EXISTS "workflow_run_events" (
  "id" TEXT NOT NULL,
  "workflow_run_id" TEXT NOT NULL,
  "from_status" TEXT,
  "to_status" TEXT NOT NULL,
  "from_state" TEXT,
  "to_state" TEXT NOT NULL,
  "state_version" INTEGER NOT NULL,
  "cause" TEXT NOT NULL,
  "detail" JSONB,
  "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workflow_run_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "workflow_run_events_workflow_run_id_ts_idx"
  ON "workflow_run_events"("workflow_run_id", "ts");

-- Links from the existing state fragments to the canonical run. NB:
-- agent_pending_actions is a legacy camelCase table — its column follows suit.
ALTER TABLE "agent_pending_actions" ADD COLUMN IF NOT EXISTS "workflowRunId" TEXT;
ALTER TABLE "agent_ask_cards" ADD COLUMN IF NOT EXISTS "workflow_run_id" TEXT;
ALTER TABLE "agent_open_tasks" ADD COLUMN IF NOT EXISTS "workflow_run_id" TEXT;
ALTER TABLE "agent_plans" ADD COLUMN IF NOT EXISTS "workflow_run_id" TEXT;
