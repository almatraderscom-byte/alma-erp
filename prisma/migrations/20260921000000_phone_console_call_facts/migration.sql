-- Phone console, step 1 (read-only): the facts a call log needs but the ERP threw away.
--
-- The SIP gateway has always POSTed direction, the caller's number, the DID, the ISDN
-- hangup cause and the transfer outcome to /api/assistant/voice-call/sip-cdr; the route
-- had nowhere to store them and dropped them on the floor. The audio counters are new:
-- until now they existed only in one log line on the VPS, so an audio regression could
-- only be caught by the owner's ear rather than by a number that moved.
--
-- Additive and safe for the live ERP. Existing rows stay NULL — these fill forward only.
ALTER TABLE "agent_voice_calls"
  ADD COLUMN IF NOT EXISTS "direction" TEXT,
  ADD COLUMN IF NOT EXISTS "from_number" TEXT,
  ADD COLUMN IF NOT EXISTS "did" TEXT,
  ADD COLUMN IF NOT EXISTS "hangup_cause" INTEGER,
  ADD COLUMN IF NOT EXISTS "hangup_cause_txt" TEXT,
  ADD COLUMN IF NOT EXISTS "transferred_to" TEXT,
  ADD COLUMN IF NOT EXISTS "transfer_talk_secs" INTEGER,
  ADD COLUMN IF NOT EXISTS "audio_underruns" INTEGER,
  ADD COLUMN IF NOT EXISTS "audio_dropped" INTEGER,
  ADD COLUMN IF NOT EXISTS "audio_cushion_frames" INTEGER,
  ADD COLUMN IF NOT EXISTS "audio_frames_out" INTEGER,
  ADD COLUMN IF NOT EXISTS "audio_silence_frames" INTEGER,
  ADD COLUMN IF NOT EXISTS "audio_barge_ins" INTEGER;

-- The console's call log is "newest first, optionally filtered", which the existing
-- (status, created_at) index cannot serve when no status filter is applied.
CREATE INDEX IF NOT EXISTS "agent_voice_calls_created_at_idx"
  ON "agent_voice_calls"("created_at");
