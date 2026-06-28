-- New feature (open-loop task tracking): durable record of work left unfinished
-- so a new task starting in the same chat doesn't make the agent "forget" the old
-- one. Two kinds: chat_followup (owner request still open) + approval_pending
-- (a confirm card awaiting decision). resume_note is a self-contained Bangla brief
-- the agent reads to resume without re-deriving context. nudge_due_at drives the
-- 30/60-min "still pending?" escalation. Additive + idempotent.
CREATE TABLE IF NOT EXISTS "agent_open_tasks" (
  "id"                TEXT NOT NULL,
  "business_id"       TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
  "conversation_id"   TEXT,
  "title"             TEXT NOT NULL,
  "kind"              TEXT NOT NULL DEFAULT 'chat_followup',
  "status"            TEXT NOT NULL DEFAULT 'open',
  "resume_note"       TEXT NOT NULL,
  "pending_action_id" TEXT,
  "nudge_due_at"      TIMESTAMP(3),
  "nudged_count"      INTEGER NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  "completed_at"      TIMESTAMP(3),
  CONSTRAINT "agent_open_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_open_tasks_conversation_status_idx" ON "agent_open_tasks"("conversation_id", "status");
CREATE INDEX IF NOT EXISTS "agent_open_tasks_nudge_idx" ON "agent_open_tasks"("business_id", "status", "nudge_due_at");
