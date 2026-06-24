-- Phase 2: DeepSeek supervisor — per-task supervisor state.
-- supervisor_clarify_count: how many clarifying questions the supervisor has asked the staff (cap 2).
-- supervisor_needs_owner: task fell to the owner (couldn't be auto-verified / understood) — the ~10%.
-- supervisor_last_tick_at: last time the supervisor acted on this task (debounce / re-triage marker).
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "supervisor_clarify_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "supervisor_needs_owner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "supervisor_last_tick_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "staff_tasks_supervisor_idx" ON "staff_tasks"("business_id", "status", "supervisor_needs_owner");
