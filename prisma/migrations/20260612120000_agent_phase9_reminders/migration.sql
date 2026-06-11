-- Phase 9: Personal reminders + urgent alert queue support (additive only)

CREATE TABLE IF NOT EXISTS agent_reminders (
  id                     TEXT        PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  title                  TEXT        NOT NULL,
  body                   TEXT,
  due_at                 TIMESTAMPTZ NOT NULL,
  recurrence_rrule       TEXT,
  tier                   INT         NOT NULL DEFAULT 1,
  voice                  BOOLEAN     NOT NULL DEFAULT TRUE,
  status                 TEXT        NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending','sent','acked','done','snoozed','cancelled')),
  snoozed_until          TIMESTAMPTZ,
  last_sent_at           TIMESTAMPTZ,
  send_count             INT         NOT NULL DEFAULT 0,
  source_conversation_id TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_reminders_status_due_idx ON agent_reminders (status, due_at);
CREATE INDEX IF NOT EXISTS agent_reminders_due_at_idx      ON agent_reminders (due_at);
