-- Phase 1: canonical Office call domain. Additive only; legacy intercom rows remain.
CREATE TYPE "OfficeCallState" AS ENUM ('CREATED', 'RINGING', 'ANSWERED', 'CONNECTING', 'CONNECTED', 'RECONNECTING', 'ENDED');
CREATE TYPE "OfficeCallTerminalReason" AS ENUM ('DECLINED', 'CANCELLED', 'MISSED', 'COMPLETED', 'FAILED', 'BUSY', 'PUSH_UNREACHABLE');
CREATE TYPE "OfficeCallLegRole" AS ENUM ('CALLER', 'CALLEE');
CREATE TYPE "OfficeCallOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'DEAD');

CREATE TABLE "office_call_sessions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "caller_user_id" TEXT NOT NULL,
    "callee_user_id" TEXT NOT NULL,
    "target_staff_id" TEXT,
    "legacy_broadcast_id" TEXT,
    "client_request_id" TEXT,
    "agora_channel" TEXT NOT NULL,
    "state" "OfficeCallState" NOT NULL DEFAULT 'CREATED',
    "terminal_reason" "OfficeCallTerminalReason",
    "version" INTEGER NOT NULL DEFAULT 0,
    "ring_expires_at" TIMESTAMP(3) NOT NULL,
    "max_ends_at" TIMESTAMP(3) NOT NULL,
    "answered_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "office_call_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "office_call_legs" (
    "id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "participant_user_id" TEXT NOT NULL,
    "role" "OfficeCallLegRole" NOT NULL,
    "state" "OfficeCallState" NOT NULL DEFAULT 'CREATED',
    "agora_uid" INTEGER NOT NULL,
    "device_id" TEXT,
    "joined_at" TIMESTAMP(3),
    "left_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "office_call_legs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "office_call_participant_locks" (
    "user_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "office_call_participant_locks_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "office_call_outbox" (
    "id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OfficeCallOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "office_call_outbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "office_call_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_token_hash" TEXT NOT NULL,
    "provider_token_enc" TEXT,
    "app_build" TEXT,
    "build_sha" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "office_call_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "office_call_sessions_legacy_broadcast_id_key" ON "office_call_sessions"("legacy_broadcast_id");
CREATE UNIQUE INDEX "office_call_sessions_agora_channel_key" ON "office_call_sessions"("agora_channel");
CREATE UNIQUE INDEX "office_call_sessions_business_id_caller_user_id_client_request_id_key" ON "office_call_sessions"("business_id", "caller_user_id", "client_request_id");
CREATE INDEX "office_call_sessions_business_id_state_created_at_idx" ON "office_call_sessions"("business_id", "state", "created_at" DESC);
CREATE INDEX "office_call_sessions_caller_user_id_state_idx" ON "office_call_sessions"("caller_user_id", "state");
CREATE INDEX "office_call_sessions_callee_user_id_state_idx" ON "office_call_sessions"("callee_user_id", "state");
CREATE UNIQUE INDEX "office_call_legs_call_id_participant_user_id_key" ON "office_call_legs"("call_id", "participant_user_id");
CREATE UNIQUE INDEX "office_call_legs_call_id_agora_uid_key" ON "office_call_legs"("call_id", "agora_uid");
CREATE INDEX "office_call_legs_participant_user_id_created_at_idx" ON "office_call_legs"("participant_user_id", "created_at" DESC);
CREATE INDEX "office_call_participant_locks_call_id_idx" ON "office_call_participant_locks"("call_id");
CREATE INDEX "office_call_participant_locks_business_id_idx" ON "office_call_participant_locks"("business_id");
CREATE UNIQUE INDEX "office_call_outbox_idempotency_key_key" ON "office_call_outbox"("idempotency_key");
CREATE INDEX "office_call_outbox_status_available_at_idx" ON "office_call_outbox"("status", "available_at");
CREATE INDEX "office_call_outbox_call_id_created_at_idx" ON "office_call_outbox"("call_id", "created_at");
CREATE UNIQUE INDEX "office_call_devices_provider_token_hash_key" ON "office_call_devices"("provider_token_hash");
CREATE INDEX "office_call_devices_user_id_active_last_seen_at_idx" ON "office_call_devices"("user_id", "active", "last_seen_at" DESC);
CREATE INDEX "office_call_devices_business_id_platform_environment_active_idx" ON "office_call_devices"("business_id", "platform", "environment", "active");

ALTER TABLE "office_call_legs" ADD CONSTRAINT "office_call_legs_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "office_call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "office_call_participant_locks" ADD CONSTRAINT "office_call_participant_locks_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "office_call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "office_call_outbox" ADD CONSTRAINT "office_call_outbox_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "office_call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "office_call_sessions"
  ADD CONSTRAINT "office_call_sessions_distinct_participants_check"
  CHECK ("caller_user_id" <> "callee_user_id");
ALTER TABLE "office_call_sessions"
  ADD CONSTRAINT "office_call_sessions_terminal_consistency_check"
  CHECK (("state" = 'ENDED' AND "terminal_reason" IS NOT NULL AND "ended_at" IS NOT NULL)
      OR ("state" <> 'ENDED' AND "terminal_reason" IS NULL AND "ended_at" IS NULL));
