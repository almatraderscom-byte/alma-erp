-- Delivery-attempt counter for the lost-poll rescue (Codex review of PR #665).
-- Its own migration: the mac_agent one had already been applied, so appending to
-- that file meant the column silently never shipped — the live agent hit
-- "deliveryAttempts column নেই" on the first real command.
ALTER TABLE "mac_agent_commands" ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;
