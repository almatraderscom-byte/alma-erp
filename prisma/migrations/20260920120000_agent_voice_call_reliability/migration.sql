-- Durable lifecycle + per-channel report outbox for asynchronous two-way calls.
-- Additive and safe for the live ERP.
ALTER TABLE "agent_voice_calls"
  ADD COLUMN IF NOT EXISTS "pending_action_id" TEXT,
  ADD COLUMN IF NOT EXISTS "provider" TEXT,
  ADD COLUMN IF NOT EXISTS "provider_status" TEXT,
  ADD COLUMN IF NOT EXISTS "dialed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "answered_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "report_received_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "agent_voice_calls_pending_action_id_idx"
  ON "agent_voice_calls"("pending_action_id");

CREATE TABLE IF NOT EXISTS "agent_voice_call_deliveries" (
  "id" TEXT NOT NULL,
  "call_id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" TIMESTAMP(3),
  "last_error" TEXT,
  "delivered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_voice_call_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_voice_call_deliveries_call_id_fkey"
    FOREIGN KEY ("call_id") REFERENCES "agent_voice_calls"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_voice_call_deliveries_call_id_channel_key"
  ON "agent_voice_call_deliveries"("call_id", "channel");

CREATE INDEX IF NOT EXISTS "agent_voice_call_deliveries_status_available_at_idx"
  ON "agent_voice_call_deliveries"("status", "available_at");
