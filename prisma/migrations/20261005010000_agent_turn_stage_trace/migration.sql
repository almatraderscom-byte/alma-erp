-- P0-2 (agent foundation audit H.5): per-stage latency trace for a turn.
-- The approval path spans three processes — Vercel approve route, Redis, the VPS
-- worker, then the chat route again — so "approve to first visible work took 90
-- seconds" could not be attributed to any one of them. Each stage now appends
-- its own {stage, at, ms} entry, so the split is a read instead of a guess.
ALTER TABLE "agent_turns" ADD COLUMN "stage_trace" JSONB;
