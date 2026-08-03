-- Durable push ledger: a transient OneSignal failure must not lose a
-- question/error/completion notification forever.
ALTER TABLE "mac_agent_session_events" ADD COLUMN "pushedAt" TIMESTAMP(3);
ALTER TABLE "mac_agent_session_events" ADD COLUMN "pushAttempts" INTEGER NOT NULL DEFAULT 0;

-- Pre-ledger rows were already handled by the old push path (or are stale) —
-- treating them as owed would fire duplicate/stale notifications on the first
-- events POST after deploy. Born settled.
UPDATE "mac_agent_session_events" SET "pushedAt" = CURRENT_TIMESTAMP WHERE "pushedAt" IS NULL;
