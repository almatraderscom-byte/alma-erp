-- Office Section · Phase A (data foundation)
-- Centralizes staff task management in-app: per-task comment threads, a task
-- timeline, in-app notifications, a Messenger-style group chat, the weekly
-- "Performer of the Week" award, and update-tracking on staff tasks.
--
-- Fully additive + idempotent. The task engine (status / proof / redo /
-- approve) already lives on staff_tasks; this only layers on top of it.

-- ── Update-tracking columns on existing staff_tasks ────────────────────────
-- "Update requested but not given" + the escalation countdown shown in both
-- the owner panel and the staff panel.
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "update_requested_at" TIMESTAMP(3);
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "update_requested_by" TEXT;
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "update_request_note" TEXT;
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "last_staff_update_at" TIMESTAMP(3);
ALTER TABLE "staff_tasks" ADD COLUMN IF NOT EXISTS "escalated_at" TIMESTAMP(3);

-- ── office_comments: per-task comment thread (owner / staff / agent) ───────
CREATE TABLE IF NOT EXISTS "office_comments" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "author_type" TEXT NOT NULL,
    "author_staff_id" TEXT,
    "author_user_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'comment',
    "body" TEXT NOT NULL,
    "attachments" JSONB,
    "seen_by_owner" BOOLEAN NOT NULL DEFAULT false,
    "seen_by_staff" BOOLEAN NOT NULL DEFAULT false,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "office_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "office_comments_task_id_created_at_idx" ON "office_comments"("task_id", "created_at");
CREATE INDEX IF NOT EXISTS "office_comments_business_id_created_at_idx" ON "office_comments"("business_id", "created_at" DESC);

DO $$ BEGIN
  ALTER TABLE "office_comments"
    ADD CONSTRAINT "office_comments_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "staff_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── office_task_events: append-only per-task timeline ──────────────────────
CREATE TABLE IF NOT EXISTS "office_task_events" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_staff_id" TEXT,
    "meta" JSONB,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "office_task_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "office_task_events_task_id_created_at_idx" ON "office_task_events"("task_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "office_task_events"
    ADD CONSTRAINT "office_task_events_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "staff_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── office_notifications: in-app bell (one recipient: owner user OR staff) ──
CREATE TABLE IF NOT EXISTS "office_notifications" (
    "id" TEXT NOT NULL,
    "recipient_user_id" TEXT,
    "recipient_staff_id" TEXT,
    "task_id" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "office_notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "office_notifications_recipient_staff_id_read_created_at_idx" ON "office_notifications"("recipient_staff_id", "read", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "office_notifications_recipient_user_id_read_created_at_idx" ON "office_notifications"("recipient_user_id", "read", "created_at" DESC);

-- ── office_group_messages: Messenger-style office group chat ───────────────
CREATE TABLE IF NOT EXISTS "office_group_messages" (
    "id" TEXT NOT NULL,
    "author_type" TEXT NOT NULL,
    "author_staff_id" TEXT,
    "author_user_id" TEXT,
    "body" TEXT NOT NULL,
    "task_ref" TEXT,
    "attachments" JSONB,
    "is_agent_reply" BOOLEAN NOT NULL DEFAULT false,
    "reply_to_id" TEXT,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "office_group_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "office_group_messages_business_id_created_at_idx" ON "office_group_messages"("business_id", "created_at" DESC);

-- ── office_weekly_awards: "Performer of the Week" (one per business/week) ──
CREATE TABLE IF NOT EXISTS "office_weekly_awards" (
    "id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "staff_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "auto" BOOLEAN NOT NULL DEFAULT true,
    "pinned_by_owner" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "office_weekly_awards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "office_weekly_awards_business_id_week_start_key" ON "office_weekly_awards"("business_id", "week_start");
CREATE INDEX IF NOT EXISTS "office_weekly_awards_staff_id_idx" ON "office_weekly_awards"("staff_id");

DO $$ BEGIN
  ALTER TABLE "office_weekly_awards"
    ADD CONSTRAINT "office_weekly_awards_staff_id_fkey"
    FOREIGN KEY ("staff_id") REFERENCES "agent_staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
