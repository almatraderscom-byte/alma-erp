-- Office Phase 3: 90/10 criticality gate + penalty/reward proposals.

-- Owner can force a specific task to always be escalated (overrides the criticality gate).
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "supervisor_always_escalate" BOOLEAN NOT NULL DEFAULT false;
-- Last criticality the supervisor computed for this task ('critical' | 'normal'). Audit only.
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "supervisor_criticality" TEXT;

-- Penalty / reward proposals the supervisor raises for the owner to approve.
-- The agent NEVER touches payroll directly — it only proposes; the owner decides.
CREATE TABLE IF NOT EXISTS "office_staff_proposals" (
  "id" TEXT NOT NULL,
  "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
  "staff_id" TEXT NOT NULL,
  "task_id" TEXT,
  "kind" TEXT NOT NULL,
  "amount" INTEGER,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decided_by" TEXT,
  "decided_at" TIMESTAMP(3),
  "meta" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "office_staff_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "office_staff_proposals_status_idx"
  ON "office_staff_proposals" ("business_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "office_staff_proposals_staff_idx"
  ON "office_staff_proposals" ("staff_id", "created_at");
-- De-dupe guard: at most one pending proposal per (task, kind).
CREATE UNIQUE INDEX IF NOT EXISTS "office_staff_proposals_pending_uniq"
  ON "office_staff_proposals" ("task_id", "kind")
  WHERE "status" = 'pending' AND "task_id" IS NOT NULL;
