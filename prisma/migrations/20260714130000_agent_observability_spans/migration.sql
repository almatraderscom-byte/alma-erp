-- Roadmap Phase 1 (observability): span fields on tool events + owner feedback.
-- Additive only.

ALTER TABLE "agent_tool_events" ADD COLUMN IF NOT EXISTS "turn_id" TEXT;
ALTER TABLE "agent_tool_events" ADD COLUMN IF NOT EXISTS "phase" TEXT NOT NULL DEFAULT 'tool';
ALTER TABLE "agent_tool_events" ADD COLUMN IF NOT EXISTS "error_code" TEXT;
ALTER TABLE "agent_tool_events" ADD COLUMN IF NOT EXISTS "detail" JSONB;
CREATE INDEX IF NOT EXISTS "agent_tool_events_turn_id_idx" ON "agent_tool_events"("turn_id");

CREATE TABLE IF NOT EXISTS "agent_owner_feedback" (
  "id" TEXT NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kind" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "turn_id" TEXT,
  "message_id" TEXT,
  "note" TEXT,
  "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
  CONSTRAINT "agent_owner_feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_owner_feedback_ts_idx" ON "agent_owner_feedback"("ts");
CREATE INDEX IF NOT EXISTS "agent_owner_feedback_kind_ts_idx" ON "agent_owner_feedback"("kind", "ts");
CREATE INDEX IF NOT EXISTS "agent_owner_feedback_conversation_id_idx" ON "agent_owner_feedback"("conversation_id");
