-- Agent turn lifecycle tracking (Component A1: background-survivable turns).
--
-- A turn must survive the iPhone app being backgrounded/closed for the common
-- case (turns <= ~280s). The server already runs the turn to completion without
-- the client connection (chat route no longer ties the turn to req.signal); this
-- table makes the running/finished state durable so the client can re-sync on
-- re-open, and gives the Stop button a cross-instance cancel signal.
--
-- Additive + idempotent (IF NOT EXISTS): safe to re-run; no existing table touched.
CREATE TABLE IF NOT EXISTS agent_turns (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running',
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  started_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at      TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "agent_turns_conversation_id_started_at_idx"
  ON agent_turns (conversation_id, started_at DESC);
