-- Phase 6: Staff Manager, Salah, Finance, Schedulers
-- Additive only — no drops or modifications to existing columns.

-- ── Staff Tasks ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS staff_tasks (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  staff_id         TEXT        NOT NULL REFERENCES agent_staff(id) ON DELETE CASCADE,
  title            TEXT        NOT NULL,
  detail           TEXT,
  type             TEXT        NOT NULL DEFAULT 'misc'
                               CHECK (type IN ('ad_creative','product_content','stock_check','listing_update','order_followup','misc')),
  product_ref      TEXT,
  status           TEXT        NOT NULL DEFAULT 'proposed'
                               CHECK (status IN ('proposed','approved','sent','done','carried','cancelled')),
  proposed_for     DATE        NOT NULL,
  completed_at     TIMESTAMPTZ,
  carried_from_task_id TEXT    REFERENCES staff_tasks(id) ON DELETE SET NULL,
  source           TEXT        NOT NULL DEFAULT 'agent'
                               CHECK (source IN ('rotation','pattern','owner','agent')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_tasks_staff_id_idx        ON staff_tasks (staff_id);
CREATE INDEX IF NOT EXISTS staff_tasks_proposed_status_idx ON staff_tasks (proposed_for, status);
CREATE INDEX IF NOT EXISTS staff_tasks_status_idx          ON staff_tasks (status);

-- ── Product Marketing History ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_marketing_history (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  product_ref      TEXT        NOT NULL,
  business         TEXT        NOT NULL,
  last_promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_type     TEXT,
  task_id          TEXT        REFERENCES staff_tasks(id) ON DELETE SET NULL,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pmh_product_ref_idx ON product_marketing_history (product_ref, last_promoted_at DESC);
CREATE INDEX IF NOT EXISTS pmh_business_idx    ON product_marketing_history (business, last_promoted_at DESC);

-- ── Salah Records ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS salah_records (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date            DATE        NOT NULL,
  waqt            TEXT        NOT NULL
                              CHECK (waqt IN ('fajr','dhuhr','asr','maghrib','isha')),
  window_start    TIMESTAMPTZ NOT NULL,
  window_end      TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','prayed_on_time','prayed_late','qaza','missed')),
  confirmed_at    TIMESTAMPTZ,
  reminders_sent  INT         NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, waqt)
);

CREATE INDEX IF NOT EXISTS salah_records_date_idx   ON salah_records (date DESC);
CREATE INDEX IF NOT EXISTS salah_records_status_idx ON salah_records (status);

-- ── Agent KV Settings (dynamic overrides) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_kv_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default salah settings
INSERT INTO agent_kv_settings (key, value) VALUES
  ('salah_escalation_level',       '2'),
  ('salah_grief_reminder_enabled', 'false'),
  ('salah_grief_context',          ''),
  ('schedulers_morning_cron',      '0 9 * * *'),
  ('schedulers_midday_cron',       '30 13 * * *'),
  ('schedulers_night_cron',        '0 21 * * *'),
  ('schedulers_weekly_cron',       '30 21 * * 5'),
  ('schedulers_summary_cron',      '30 23 * * *'),
  ('schedulers_ads_cron',          '30 9 * * *')
ON CONFLICT (key) DO NOTHING;

-- ── Salah Overrides ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS salah_overrides (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date        DATE,
  waqt        TEXT        CHECK (waqt IN ('fajr','dhuhr','asr','maghrib','isha')),
  override_time TIMESTAMPTZ,
  delay_until   TIMESTAMPTZ,
  skip        BOOLEAN     NOT NULL DEFAULT FALSE,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS salah_overrides_date_waqt_idx ON salah_overrides (date, waqt);

-- ── Finance: Expenses ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance_expenses (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  amount      INT         NOT NULL CHECK (amount > 0),
  currency    TEXT        NOT NULL DEFAULT 'BDT' CHECK (currency IN ('BDT','AED')),
  category    TEXT,
  note        TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS finance_expenses_occurred_idx  ON finance_expenses (occurred_at DESC);
CREATE INDEX IF NOT EXISTS finance_expenses_currency_idx  ON finance_expenses (currency);
CREATE INDEX IF NOT EXISTS finance_expenses_category_idx  ON finance_expenses (category);

-- ── Finance: Ledger ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance_ledger (
  id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  person_name  TEXT        NOT NULL,
  direction    TEXT        NOT NULL
                           CHECK (direction IN ('lent','borrowed','repaid_to_me','repaid_by_me')),
  amount       INT         NOT NULL CHECK (amount > 0),
  currency     TEXT        NOT NULL DEFAULT 'BDT' CHECK (currency IN ('BDT','AED')),
  note         TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS finance_ledger_person_idx     ON finance_ledger (person_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS finance_ledger_direction_idx  ON finance_ledger (direction);

-- ── Messenger Alert Log ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messenger_alerts (
  id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  page_id         TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL,
  alert_type      TEXT        NOT NULL
                              CHECK (alert_type IN ('unanswered_30min','image_only_reply','dead_after_question')),
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved        BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, alert_type, detected_at::date)
);

CREATE INDEX IF NOT EXISTS messenger_alerts_page_idx     ON messenger_alerts (page_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS messenger_alerts_resolved_idx ON messenger_alerts (resolved, detected_at DESC);
