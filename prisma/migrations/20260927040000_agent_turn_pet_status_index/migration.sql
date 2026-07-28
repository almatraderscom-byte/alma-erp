-- Supports the app-wide Office Robot's active-count and latest-completion poll.
-- The status prefix serves the running count; the full key serves the terminal
-- completion lookup without scanning the agent_turns table.
CREATE INDEX IF NOT EXISTS "agent_turns_status_continuation_needed_finished_at_idx"
ON "agent_turns"("status", "continuation_needed", "finished_at" DESC);
