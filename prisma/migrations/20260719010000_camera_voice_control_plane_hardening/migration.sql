-- Additive lease metadata for crash-safe, idempotent camera speaker delivery.
ALTER TABLE "agent_camera_speak_jobs"
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "agent_camera_speak_jobs_status_lease_expires_at_idx"
  ON "agent_camera_speak_jobs"("status", "lease_expires_at");
