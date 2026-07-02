-- Camera-speaker announcement queue (owner/head agent queues Bangla TTS; the
-- office-PC bridge polls, plays through a camera speaker via go2rtc).
-- Additive only — no existing table is touched.
CREATE TABLE IF NOT EXISTS "agent_camera_speak_jobs" (
    "id" TEXT NOT NULL,
    "stream" TEXT NOT NULL DEFAULT 'workroom',
    "text" TEXT NOT NULL,
    "audio_path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),

    CONSTRAINT "agent_camera_speak_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_camera_speak_jobs_status_created_at_idx"
    ON "agent_camera_speak_jobs"("status", "created_at");
