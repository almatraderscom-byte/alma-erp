-- Intelligence A: agent outcome loop — track whether suggestions correlated with results
CREATE TABLE IF NOT EXISTS "agent_outcomes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" TEXT,
    "subject_name" TEXT,
    "suggestion" TEXT NOT NULL,
    "rationale" TEXT,
    "metric" TEXT NOT NULL,
    "baseline_value" DOUBLE PRECISION,
    "predicted" TEXT,
    "measure_after" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "actual_value" DOUBLE PRECISION,
    "result" TEXT,
    "learning" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "measured_at" TIMESTAMP(3),
    "owner_actioned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "agent_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_outcomes_status_measure_after_idx" ON "agent_outcomes"("status", "measure_after");
CREATE INDEX IF NOT EXISTS "agent_outcomes_type_idx" ON "agent_outcomes"("type");
