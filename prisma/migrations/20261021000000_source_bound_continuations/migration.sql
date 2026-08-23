-- Expand-only, rollback-safe source binding for server continuations.
-- Rollback is AGENT_SOURCE_BOUND_CONTINUATIONS=false; legacy turns stay valid
-- because both columns are nullable and no existing row is rewritten.
ALTER TABLE "agent_turns"
  ADD COLUMN IF NOT EXISTS "continuation_binding" JSONB,
  ADD COLUMN IF NOT EXISTS "continuation_execution_claimed_at" TIMESTAMP(3);
