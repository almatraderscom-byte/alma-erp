-- Phase 10: ask_user cards, staff reply stats, staff GPS locations (additive only)

CREATE TABLE IF NOT EXISTS agent_ask_cards (
  id               TEXT        PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  conversation_id  TEXT        NOT NULL,
  question         TEXT        NOT NULL,
  options          TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',
  selected_option  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_ask_cards_conv_status_idx ON agent_ask_cards (conversation_id, status);

CREATE TABLE IF NOT EXISTS staff_reply_stats (
  id               TEXT        PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  staff_id         TEXT        REFERENCES agent_staff(id) ON DELETE SET NULL,
  page_id          TEXT        NOT NULL,
  conversation_id  TEXT        NOT NULL,
  customer_msg_at  TIMESTAMPTZ NOT NULL,
  first_reply_at   TIMESTAMPTZ NOT NULL,
  reply_minutes    INT         NOT NULL,
  date             DATE        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_reply_stats_staff_date_idx ON staff_reply_stats (staff_id, date);
CREATE INDEX IF NOT EXISTS staff_reply_stats_date_idx        ON staff_reply_stats (date);

CREATE TABLE IF NOT EXISTS staff_locations (
  id           TEXT             PRIMARY KEY DEFAULT CAST(gen_random_uuid() AS TEXT),
  staff_id     TEXT             NOT NULL REFERENCES agent_staff(id) ON DELETE CASCADE,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  accuracy     DOUBLE PRECISION,
  recorded_at  TIMESTAMPTZ      NOT NULL,
  source       TEXT             NOT NULL,
  metadata     TEXT,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_locations_staff_recorded_idx ON staff_locations (staff_id, recorded_at DESC);
