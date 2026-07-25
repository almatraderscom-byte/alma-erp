-- The one hop the phone console could not see: what the NETWORK did to a call.
--
-- A call's recording is tapped inside Asterisk, before the audio goes on the wire, so by
-- construction it cannot contain packet loss or freezes that happen afterwards. That is
-- exactly why a recording can sound clean while the call did not. The gateway now samples
-- Asterisk's own RTP counters while each call is up and posts them with the CDR.
--
-- `audio_turn_ends` is separate from `audio_underruns` on purpose: the playout used to count
-- the model finishing a sentence as a dry-out, which ratcheted the jitter cushion up once
-- per turn and added delay to every later reply.
--
-- Additive and safe for the live ERP. Existing rows stay NULL — these fill forward only.
ALTER TABLE "agent_voice_calls"
  ADD COLUMN IF NOT EXISTS "audio_turn_ends" INTEGER,
  ADD COLUMN IF NOT EXISTS "rtp_codec" TEXT,
  ADD COLUMN IF NOT EXISTS "rtp_rx_lost" INTEGER,
  ADD COLUMN IF NOT EXISTS "rtp_rx_lost_pct" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "rtp_rx_jitter_ms" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "rtp_tx_lost" INTEGER,
  ADD COLUMN IF NOT EXISTS "rtp_tx_lost_pct" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "rtp_tx_jitter_ms" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "rtp_rtt_ms" DOUBLE PRECISION;
