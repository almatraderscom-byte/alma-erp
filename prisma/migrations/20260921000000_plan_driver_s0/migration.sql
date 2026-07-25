-- Plan-Driver S0 — make the autonomous engine structurally correct.
-- Additive only; safe for the live ERP (the driver itself stays behind
-- AGENT_AUTODRIVE_ENABLED, which is OFF).
--
-- Why each column exists:
--   agent_plan_steps.attempt_count / max_attempts / next_attempt_at
--     A failed step used to be terminal: getReadySteps only returned 'pending',
--     so ONE failure ended the whole plan at 'escalated-stuck' and the plan-level
--     maxAttempts=5 was unreachable. Retries are now per step, with backoff.
--   agent_plan_steps.turn_id / dispatched_at
--     Queue mode: a step turn runs on the worker's long-agent-task queue instead
--     of inside the 120s tick. The step records WHICH turn it is waiting on so a
--     later tick can reap the verdict.
--   agent_plans.cost_milli_taka*
--     Whole-taka rounding charged 1৳ to every sub-taka turn, and the "daily"
--     spend summed each plan's LIFETIME cost — so the engine strangled itself
--     after a few days. Spend is now milli-taka, with a per-day bucket.
--   agent_turns.instruction_origin
--     An unattended plan step must run under 'owner_policy' (autonomy ladder +
--     money cap apply), not 'owner_direct'. The turn row carries it so both the
--     inline and the queued path see the same origin.

ALTER TABLE "agent_plan_steps"
  ADD COLUMN IF NOT EXISTS "attempt_count"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "max_attempts"    INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "turn_id"         TEXT,
  ADD COLUMN IF NOT EXISTS "dispatched_at"   TIMESTAMP(3);

ALTER TABLE "agent_plans"
  ADD COLUMN IF NOT EXISTS "cost_milli_taka"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cost_milli_taka_day" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cost_day"            TEXT;

ALTER TABLE "agent_turns"
  ADD COLUMN IF NOT EXISTS "instruction_origin" TEXT;

CREATE INDEX IF NOT EXISTS "agent_plan_steps_plan_status_idx"
  ON "agent_plan_steps"("plan_id", "status");

CREATE INDEX IF NOT EXISTS "agent_plans_cost_day_idx"
  ON "agent_plans"("cost_day");
