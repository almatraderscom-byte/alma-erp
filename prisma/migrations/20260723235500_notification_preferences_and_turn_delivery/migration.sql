-- Professional per-user notification controls + durable agent-turn completion
-- delivery. Additive and idempotent: no existing notification or turn rows are
-- rewritten.

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "highPriorityOnly" BOOLEAN NOT NULL DEFAULT FALSE,
  "criticalAlways" BOOLEAN NOT NULL DEFAULT TRUE,
  "agentCompletions" BOOLEAN NOT NULL DEFAULT TRUE,
  "approvals" BOOLEAN NOT NULL DEFAULT TRUE,
  "orders" BOOLEAN NOT NULL DEFAULT TRUE,
  "payrollWallet" BOOLEAN NOT NULL DEFAULT TRUE,
  "inventory" BOOLEAN NOT NULL DEFAULT TRUE,
  "finance" BOOLEAN NOT NULL DEFAULT TRUE,
  "announcements" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_userId_key"
  ON "notification_preferences"("userId");
CREATE INDEX IF NOT EXISTS "notification_preferences_enabled_idx"
  ON "notification_preferences"("enabled");

CREATE TABLE IF NOT EXISTS "agent_turn_notification_deliveries" (
  "id" TEXT NOT NULL,
  "turn_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "preview" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_turn_notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_turn_notification_deliveries_turn_id_key"
  ON "agent_turn_notification_deliveries"("turn_id");
CREATE INDEX IF NOT EXISTS "agent_turn_notification_deliveries_status_available_at_idx"
  ON "agent_turn_notification_deliveries"("status", "available_at");
