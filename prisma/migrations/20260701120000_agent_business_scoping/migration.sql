-- Phase 7: ALMA Trading agent integration — business scoping for agent module.
-- Additive only. Existing rows default to ALMA_LIFESTYLE except agent_projects
-- whose name matches "ALMA Trading" → ALMA_TRADING.

-- ── agent_projects ──────────────────────────────────────────────────────────
ALTER TABLE "agent_projects"
  ADD COLUMN IF NOT EXISTS "business_id" text;

CREATE INDEX IF NOT EXISTS "agent_projects_business_id_idx"
  ON "agent_projects" ("business_id");

-- Backfill: seed "ALMA Trading" project → ALMA_TRADING.
UPDATE "agent_projects"
SET "business_id" = 'ALMA_TRADING'
WHERE lower("name") LIKE '%trading%' AND "business_id" IS NULL;

UPDATE "agent_projects"
SET "business_id" = 'ALMA_LIFESTYLE'
WHERE lower("name") LIKE '%lifestyle%' AND "business_id" IS NULL;

-- ── agent_conversations ─────────────────────────────────────────────────────
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "business_id" text;

CREATE INDEX IF NOT EXISTS "agent_conversations_business_id_idx"
  ON "agent_conversations" ("business_id");

-- Backfill from project. Cast both sides to text since projectId may be text
-- while agent_projects.id is uuid on some environments.
UPDATE "agent_conversations" c
SET "business_id" = p."business_id"
FROM "agent_projects" p
WHERE c."projectId"::text = p."id"::text
  AND c."business_id" IS NULL
  AND p."business_id" IS NOT NULL;

-- ── agent_pending_actions ───────────────────────────────────────────────────
ALTER TABLE "agent_pending_actions"
  ADD COLUMN IF NOT EXISTS "business_id" text NOT NULL DEFAULT 'ALMA_LIFESTYLE';

CREATE INDEX IF NOT EXISTS "agent_pending_actions_business_status_idx"
  ON "agent_pending_actions" ("business_id", "status");

-- Backfill pending actions from their conversation's businessId.
UPDATE "agent_pending_actions" pa
SET "business_id" = c."business_id"
FROM "agent_conversations" c
WHERE pa."conversationId"::text = c."id"::text
  AND c."business_id" IS NOT NULL
  AND pa."business_id" = 'ALMA_LIFESTYLE'
  AND c."business_id" <> 'ALMA_LIFESTYLE';

-- ── agent_staff ─────────────────────────────────────────────────────────────
ALTER TABLE "agent_staff"
  ADD COLUMN IF NOT EXISTS "business_id" text NOT NULL DEFAULT 'ALMA_LIFESTYLE',
  ADD COLUMN IF NOT EXISTS "user_id" text;

CREATE INDEX IF NOT EXISTS "agent_staff_business_active_idx"
  ON "agent_staff" ("business_id", "active");

CREATE INDEX IF NOT EXISTS "agent_staff_user_id_idx"
  ON "agent_staff" ("user_id");

-- FK on user_id (ON DELETE SET NULL keeps staff row if User is removed).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_staff_user_id_fkey'
  ) THEN
    ALTER TABLE "agent_staff"
      ADD CONSTRAINT "agent_staff_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── staff_tasks ─────────────────────────────────────────────────────────────
ALTER TABLE "staff_tasks"
  ADD COLUMN IF NOT EXISTS "business_id" text NOT NULL DEFAULT 'ALMA_LIFESTYLE';

CREATE INDEX IF NOT EXISTS "staff_tasks_business_proposed_status_idx"
  ON "staff_tasks" ("business_id", "proposed_for", "status");

-- Backfill staff_tasks.business_id from agent_staff.
UPDATE "staff_tasks" t
SET "business_id" = s."business_id"
FROM "agent_staff" s
WHERE t."staff_id"::text = s."id"::text
  AND t."business_id" = 'ALMA_LIFESTYLE'
  AND s."business_id" <> 'ALMA_LIFESTYLE';

-- ── staff_lunch ─────────────────────────────────────────────────────────────
ALTER TABLE "staff_lunch"
  ADD COLUMN IF NOT EXISTS "business_id" text NOT NULL DEFAULT 'ALMA_LIFESTYLE';

CREATE INDEX IF NOT EXISTS "staff_lunch_business_date_idx"
  ON "staff_lunch" ("business_id", "lunch_date");

-- Backfill staff_lunch.business_id from agent_staff.
UPDATE "staff_lunch" l
SET "business_id" = s."business_id"
FROM "agent_staff" s
WHERE l."staff_id"::text = s."id"::text
  AND l."business_id" = 'ALMA_LIFESTYLE'
  AND s."business_id" <> 'ALMA_LIFESTYLE';
