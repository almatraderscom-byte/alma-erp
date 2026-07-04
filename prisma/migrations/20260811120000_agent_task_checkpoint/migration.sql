-- P0 checkpoint standard: structured resume state on open tasks (additive).
-- kind gains 'checkpoint_failed' / 'checkpoint_waiting' values (kind is TEXT — no enum change).
ALTER TABLE "agent_open_tasks" ADD COLUMN IF NOT EXISTS "checkpoint" JSONB;
