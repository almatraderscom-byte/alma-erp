-- Plan-Driver Phase A: autonomous "pursue-until-completion" foundation.
--
-- Adds durable autodrive bookkeeping to agent_plans so a worker tick can later
-- re-drive a stalled multi-step plan across many short ticks (serverless can't run
-- a long loop in one request). Phase A only READS these columns (shadow/dry-run);
-- the executor + completion gate land in Phase B/C.
--
--   done_criteria    : plain-language "what counts as DONE" — the completion gate reads this.
--   autodrive_state  : driver lifecycle — idle | driving | blocked | done | failed | abandoned.
--   attempt_count    : how many drive attempts so far (loop guard with max_attempts).
--   max_attempts     : per-plan attempt ceiling before escalating to the owner.
--   next_tick_at     : backoff watermark — driver skips the plan until this time.
--   last_driven_at   : observability — when the driver last touched this plan.
--   cost_taka        : whole-taka autodrive spend on this plan (daily cost-cap input).
--
-- Additive + idempotent (IF NOT EXISTS): safe to re-run; no existing rows touched;
-- every column has a default or is nullable so live ERP data is unaffected.
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS done_criteria   TEXT;
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS autodrive_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS attempt_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS max_attempts    INTEGER NOT NULL DEFAULT 5;
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS next_tick_at    TIMESTAMP(3);
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS last_driven_at  TIMESTAMP(3);
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS cost_taka       INTEGER NOT NULL DEFAULT 0;

-- The driver query is "find drivable plans": non-terminal autodrive_state whose
-- next_tick_at has passed. This partial-friendly index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS agent_plans_autodrive_idx
  ON agent_plans (autodrive_state, next_tick_at);
