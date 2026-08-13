-- Persist the native installation that atomically wins an Agent app-call
-- answer. Terminal device reports are accepted only from that installation;
-- trusted server recovery remains possible for legacy/null-owner rows.
ALTER TABLE "agent_app_calls"
ADD COLUMN "answering_device_id" VARCHAR(180),
ADD COLUMN "eligible_device_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "claim_receipt_hash" CHAR(64);
