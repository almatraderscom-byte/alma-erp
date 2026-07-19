-- Scheduled two-way calls: the agent queues a call for a future time; the
-- /api/cron/scheduled-calls cron fires each due row via placeOutboundCall. Additive.
CREATE TABLE "scheduled_calls" (
    "id" TEXT NOT NULL,
    "to_number" TEXT NOT NULL,
    "recipient_name" TEXT,
    "purpose" TEXT NOT NULL,
    "first_message" TEXT,
    "call_type" TEXT NOT NULL DEFAULT 'contact',
    "voice_gender" TEXT NOT NULL DEFAULT 'female',
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "placed_call_id" TEXT,
    "error" TEXT,
    "conversation_id" TEXT,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placed_at" TIMESTAMP(3),
    CONSTRAINT "scheduled_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scheduled_calls_status_due_at_idx" ON "scheduled_calls"("status", "due_at");
