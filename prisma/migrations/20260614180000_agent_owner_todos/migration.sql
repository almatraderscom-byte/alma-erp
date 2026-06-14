-- Phase F: Owner personal todo tracker (additive only)

CREATE TABLE IF NOT EXISTS agent_owner_todos (
  id                       TEXT        PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  title                    TEXT        NOT NULL,
  detail                   TEXT,
  status                   TEXT        NOT NULL DEFAULT 'open',
  priority                 TEXT        NOT NULL DEFAULT 'normal',
  due_hint                 TEXT,
  nudge_after_days         INT         NOT NULL DEFAULT 3,
  last_nudged_at           TIMESTAMPTZ,
  source_conversation_id   TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_owner_todos_status_created_idx ON agent_owner_todos (status, created_at);
