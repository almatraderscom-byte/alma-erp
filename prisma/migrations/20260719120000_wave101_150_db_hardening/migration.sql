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

-- #130: staff_tasks.source CHECK — add new sources from bonus_suggest, daily_strategist, agent
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
  'content_engine'
));

-- #131: index (type, status) on agent_pending_actions for fast approval queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_pending_actions_type_status"
  ON "agent_pending_actions" ("type", "status");

-- #132: index on agent_pending_actions("createdAt") for stale-action queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_pending_actions_created_at"
  ON "agent_pending_actions" ("createdAt");
