-- Phase 0: append-only cross-platform call observability ledger.
-- No foreign key is intentional: evidence must survive legacy intercom cleanup
-- and the Phase 1 migration to an authoritative call-session model.
CREATE TABLE "office_call_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "call_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "device_id" TEXT,
    "source" TEXT NOT NULL,
    "platform" TEXT,
    "app_build" TEXT,
    "build_sha" TEXT,
    "event" TEXT NOT NULL,
    "state" TEXT,
    "provider" TEXT,
    "success" BOOLEAN,
    "latency_ms" INTEGER,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "office_call_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "office_call_events_call_id_occurred_at_idx"
    ON "office_call_events"("call_id", "occurred_at" ASC);
CREATE INDEX "office_call_events_business_id_occurred_at_idx"
    ON "office_call_events"("business_id", "occurred_at" DESC);
CREATE INDEX "office_call_events_event_occurred_at_idx"
    ON "office_call_events"("event", "occurred_at" DESC);
