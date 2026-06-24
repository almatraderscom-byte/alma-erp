-- Agent outbound phone calls (ElevenLabs Conversational AI + Twilio).
-- Records every agent-placed two-way Bangla call: who was called, why, the live
-- status, and — after the call ends — the full transcript + summary delivered by
-- the ElevenLabs post-call webhook. Additive only; no existing table touched.
CREATE TABLE "agent_voice_calls" (
    "id" TEXT NOT NULL,
    "eleven_conversation_id" TEXT,
    "call_sid" TEXT,
    "to_number" TEXT NOT NULL,
    "recipient_name" TEXT,
    "purpose" TEXT,
    "first_message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "transcript" JSONB,
    "summary" TEXT,
    "duration_secs" INTEGER,
    "cost_credits" INTEGER,
    "conversation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "agent_voice_calls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_voice_calls_eleven_conversation_id_key" ON "agent_voice_calls"("eleven_conversation_id");
CREATE INDEX "agent_voice_calls_status_created_at_idx" ON "agent_voice_calls"("status", "created_at");
CREATE INDEX "agent_voice_calls_conversation_id_idx" ON "agent_voice_calls"("conversation_id");
