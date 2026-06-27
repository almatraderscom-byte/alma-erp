-- Phase D (office context continuity): durable per-task follow-up schedule.
-- next_follow_up_at records WHEN the supervisor should next check in on this task
-- (deadline-aware). Persisting it means a follow-up survives restarts / day
-- boundaries instead of being recomputed from a flat idle timer each tick, so the
-- agent no longer "forgets" to chase a task across days. Additive + idempotent.
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "next_follow_up_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "staff_tasks_next_followup_idx" ON "staff_tasks"("business_id", "status", "next_follow_up_at");
