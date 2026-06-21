-- Agent turn event log (Component A2: VPS handoff for genuinely long turns).
--
-- A turn that runs on the VPS worker (long jobs that exceed Vercel's 300s cap)
-- publishes each SSE event to a Redis pub/sub channel for live tailing AND
-- appends it here for replay. The stream endpoint replays these rows in `seq`
-- order on (re)connect, then tails Redis for anything newer — so a client that
-- backgrounds and re-opens never loses events.
--
-- Additive + idempotent (IF NOT EXISTS): safe to re-run; no existing table touched.
CREATE TABLE IF NOT EXISTS agent_turn_events (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per (turn, seq): makes the worker's append idempotent under BullMQ retries.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_turn_events_turn_id_seq_key"
  ON agent_turn_events (turn_id, seq);
