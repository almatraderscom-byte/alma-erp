-- Wave 101-150 DB hardening: defaults, indexes, constraints

-- #125: agent_todos — ensure id/updated_at have DB defaults for raw inserts
ALTER TABLE "agent_todos"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "agent_todos"
  ALTER COLUMN "updated_at" SET DEFAULT now();

-- #126: agent_plans / agent_plan_steps — same
ALTER TABLE "agent_plans"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "agent_plan_steps"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- #127: agent_tool_events — PK default
ALTER TABLE "agent_tool_events"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- #128: agent_duty_log.duty_date TEXT — add format CHECK (YYYY-MM-DD)
ALTER TABLE "agent_duty_log"
  DROP CONSTRAINT IF EXISTS "agent_duty_log_duty_date_format_check";
ALTER TABLE "agent_duty_log"
  ADD CONSTRAINT "agent_duty_log_duty_date_format_check"
  CHECK (duty_date ~ '^\d{4}-\d{2}-\d{2}$');

-- #130: staff_tasks.source CHECK — allow every source the code actually writes.
-- NOTE: 'rotation' and 'pattern' are produced by staff-task-proposal.ts and already
-- exist in production rows; omitting them made this migration fail (error 23514,
-- "violated by some row") and blocked ALL prod deploys since 2026-06-17.
ALTER TABLE "staff_tasks" DROP CONSTRAINT IF EXISTS "staff_tasks_source_check";
ALTER TABLE "staff_tasks" ADD CONSTRAINT "staff_tasks_source_check" CHECK (source IN (
  'owner',
  'agent',
  'strategist',
  'daily_strategist',
  'bonus_suggest',
  'evening_proposal',
  'morning_proposal',
  'manual',
  'scheduler',
  'day_shift',
  'content_engine',
  'rotation',
  'pattern'
));

-- #131: index (type, status) on agent_pending_actions for fast approval queries.
-- Plain (non-CONCURRENT) CREATE: Prisma wraps each migration in a transaction and
-- CREATE INDEX CONCURRENTLY cannot run inside one. agent_pending_actions is a small
-- agent-internal table, so the brief build lock is harmless.
CREATE INDEX IF NOT EXISTS "idx_agent_pending_actions_type_status"
  ON "agent_pending_actions" ("type", "status");

-- #132: index on agent_pending_actions("createdAt") for stale-action queries
CREATE INDEX IF NOT EXISTS "idx_agent_pending_actions_created_at"
  ON "agent_pending_actions" ("createdAt");
