-- Staff task verification — proof + owner review before final done.
-- Additive only.

ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS proof_type TEXT;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS proof_data JSONB;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS reviewer_note TEXT;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS redo_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE staff_tasks DROP CONSTRAINT IF EXISTS staff_tasks_status_check;
ALTER TABLE staff_tasks ADD CONSTRAINT staff_tasks_status_check CHECK (status IN (
  'proposed',
  'approved',
  'sent',
  'awaiting_proof',
  'done',
  'done_unverified',
  'carried',
  'cancelled'
));

ALTER TABLE staff_tasks DROP CONSTRAINT IF EXISTS staff_tasks_verification_status_check;
ALTER TABLE staff_tasks ADD CONSTRAINT staff_tasks_verification_status_check CHECK (verification_status IN (
  'not_required',
  'awaiting_proof',
  'proof_submitted',
  'auto_verified',
  'owner_approved',
  'redo_requested'
));

INSERT INTO agent_kv_settings (key, value)
VALUES ('task_verification_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
