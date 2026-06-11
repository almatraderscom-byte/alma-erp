-- Phase 8: Cost dashboard — additive only

CREATE TABLE IF NOT EXISTS agent_cost_events (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider        TEXT        NOT NULL,
  kind            TEXT        NOT NULL,
  units           JSONB       NOT NULL DEFAULT '{}',
  cost_usd        NUMERIC(10,6) NOT NULL,
  conversation_id TEXT,
  job_id          TEXT,
  dedup_key       TEXT        UNIQUE,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_cost_events_occurred_at_idx
  ON agent_cost_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS agent_cost_events_provider_occurred_idx
  ON agent_cost_events (provider, occurred_at DESC);
CREATE INDEX IF NOT EXISTS agent_cost_events_conversation_idx
  ON agent_cost_events (conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_subscriptions (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT        NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'USD',
  billing_cycle   TEXT        NOT NULL,
  next_renewal_at DATE        NOT NULL,
  category        TEXT,
  notes           TEXT,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_subscriptions_renewal_idx
  ON agent_subscriptions (next_renewal_at)
  WHERE active = TRUE;
