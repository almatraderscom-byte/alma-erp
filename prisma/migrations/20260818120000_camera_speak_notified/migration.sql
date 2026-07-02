-- Outcome notification for camera announcements: the sweep tells the owner
-- "✅ বেজেছে / ⚠️ বাজেনি" exactly once per job. Additive only.
ALTER TABLE "agent_camera_speak_jobs"
    ADD COLUMN IF NOT EXISTS "notified_at" TIMESTAMP(3);

-- Backfill: jobs from before this feature were already reported in-session —
-- never spam the owner about them on first deploy.
UPDATE "agent_camera_speak_jobs" SET "notified_at" = CURRENT_TIMESTAMP
    WHERE "notified_at" IS NULL;
