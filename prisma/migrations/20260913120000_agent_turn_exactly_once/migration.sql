-- Exactly-once owner sends and structured automatic continuations.
-- Additive only: existing messages/turns remain valid with NULL provenance.

ALTER TABLE "agent_messages"
  ADD COLUMN IF NOT EXISTS "client_request_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_messages_client_request_id_key"
  ON "agent_messages" ("client_request_id");

ALTER TABLE "agent_turns"
  ADD COLUMN IF NOT EXISTS "request_id" TEXT,
  ADD COLUMN IF NOT EXISTS "continuation_of_turn_id" TEXT,
  ADD COLUMN IF NOT EXISTS "continuation_needed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "continuation_claimed_at" TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_turns_request_id_key"
  ON "agent_turns" ("request_id");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_turns_continuation_of_turn_id_key"
  ON "agent_turns" ("continuation_of_turn_id");

-- Expensive background actions can opt into a stable logical-task key. NULL
-- keeps every existing action and all unrelated action types unchanged.
ALTER TABLE "agent_pending_actions"
  ADD COLUMN IF NOT EXISTS "dedupe_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_pending_actions_dedupe_key_key"
  ON "agent_pending_actions" ("dedupe_key");
