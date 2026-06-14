-- Staff feedback channel — staff → owner (additive).

CREATE TABLE IF NOT EXISTS staff_feedback (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  staff_id      TEXT NOT NULL REFERENCES agent_staff(id) ON DELETE CASCADE,
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_by_owner BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS staff_feedback_staff_id_created_at_idx
  ON staff_feedback (staff_id, created_at DESC);
