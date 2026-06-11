-- Phase 5: agent_notifications + agent_staff (additive only)

CREATE TABLE "agent_notifications" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "tier"      INTEGER NOT NULL,
  "category"  TEXT,
  "title"     TEXT NOT NULL,
  "message"   TEXT NOT NULL,
  "channels"  JSONB NOT NULL,
  "statuses"  JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_notifications_tier_idx"       ON "agent_notifications"("tier");
CREATE INDEX "agent_notifications_createdAt_idx"  ON "agent_notifications"("createdAt");

CREATE TABLE "agent_staff" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "name"           TEXT NOT NULL,
  "role"           TEXT NOT NULL,
  "telegramChatId" TEXT,
  "active"         BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_staff_pkey" PRIMARY KEY ("id")
);

-- Seed initial staff members (no Telegram IDs yet — linked in Phase 6 via /staff command)
INSERT INTO "agent_staff" ("id", "name", "role", "active", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::TEXT, 'Mohammad Eyafi', 'staff', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'Mustahid',       'staff', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
