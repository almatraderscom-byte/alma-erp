-- Staff message acknowledgement + per-staff NTFY topics (additive)

ALTER TABLE agent_outbox
  ADD COLUMN IF NOT EXISTS short_id TEXT,
  ADD COLUMN IF NOT EXISTS requires_ack BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_escalated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_outbox_short_id_idx ON agent_outbox (short_id);

ALTER TABLE agent_staff
  ADD COLUMN IF NOT EXISTS ntfy_topic TEXT;
