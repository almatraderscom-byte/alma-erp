-- Phase 7: Worker heartbeat rows for watchdog monitoring (additive only)

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  service      TEXT        PRIMARY KEY,
  last_beat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
