-- Call recording (owner requirement 2026-07-25): keep a listenable copy of every call.
-- Additive only: two nullable columns on an existing table, no backfill, no default change.
-- recording_url  = signed/public Supabase URL of the mixed audio for the whole call,
--                  including anything said AFTER a transfer to a human (the bridge keeps
--                  recording once the AI steps off the audio path, which is exactly the
--                  stretch nobody could account for before).
-- recording_secs = duration of that audio, so the UI can show length without fetching it.
ALTER TABLE "agent_voice_calls" ADD COLUMN IF NOT EXISTS "recording_url" TEXT;
ALTER TABLE "agent_voice_calls" ADD COLUMN IF NOT EXISTS "recording_secs" INTEGER;
