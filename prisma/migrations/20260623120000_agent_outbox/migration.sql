-- Agent outbox — verifiable staff message delivery log (additive).

CREATE TABLE IF NOT EXISTS agent_outbox (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  staff_id            TEXT,
  staff_name          TEXT,
  business_id         TEXT,
  type                TEXT NOT NULL,
  content             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  telegram_message_id TEXT,
  error_reason        TEXT,
  related_task_ids    JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_outbox_created_at_idx ON agent_outbox (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_outbox_staff_id_idx ON agent_outbox (staff_id);
CREATE INDEX IF NOT EXISTS agent_outbox_status_idx ON agent_outbox (status);
