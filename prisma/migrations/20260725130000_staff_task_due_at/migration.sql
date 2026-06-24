-- Phase 1 (office autonomy): owner-set deadline per staff task.
-- The owner fixes a due time when assigning/approving a task; the office board
-- and the (later) supervisor loop use it to flag overdue work. Additive + idempotent.
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "due_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "staff_tasks_business_due_idx" ON "staff_tasks"("business_id", "due_at");
