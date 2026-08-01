-- Durable push ledger: a transient OneSignal failure must not lose a
-- question/error/completion notification forever.
ALTER TABLE "mac_agent_session_events" ADD COLUMN "pushedAt" TIMESTAMP(3);
ALTER TABLE "mac_agent_session_events" ADD COLUMN "pushAttempts" INTEGER NOT NULL DEFAULT 0;
