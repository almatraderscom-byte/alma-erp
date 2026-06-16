-- Idempotency hardening: enforce uniqueness on meta_message_id.
-- This prevents duplicate cs_messages rows when Meta retries the webhook
-- and our SELECT-then-INSERT path in messenger-ingest.ts races.
--
-- Partial index — NULL meta_message_id rows (outbound replies) stay unconstrained.
-- Table currently has ~44 rows with a non-null meta_message_id, no duplicates.

CREATE UNIQUE INDEX IF NOT EXISTS "cs_messages_meta_message_id_key"
  ON "cs_messages"("meta_message_id")
  WHERE "meta_message_id" IS NOT NULL;
