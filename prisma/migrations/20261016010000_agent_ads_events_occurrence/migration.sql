-- Persist the occurrence identity of the last accepted delivery, so a Meta
-- redelivery that arrives AFTER the short KV window (or after its key is evicted)
-- is still recognised as the same occurrence instead of reopening a handled alert.
ALTER TABLE "agent_ads_events" ADD COLUMN IF NOT EXISTS "occurrence_tag" TEXT;
