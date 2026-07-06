-- Office Live Intercom: owner → staff walkie-talkie voice broadcasts + per-staff
-- delivery/confirmation receipts. Additive only.

CREATE TABLE "office_intercom_broadcasts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "sender_user_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'voice',
    "audio_path" TEXT,
    "audio_url" TEXT,
    "media_type" TEXT,
    "duration_sec" INTEGER NOT NULL DEFAULT 0,
    "transcript" TEXT,
    "target_staff_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "office_intercom_broadcasts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "office_intercom_broadcasts_business_id_created_at_idx"
    ON "office_intercom_broadcasts"("business_id", "created_at" DESC);

CREATE TABLE "office_intercom_receipts" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "played_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "office_intercom_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "office_intercom_receipts_broadcast_id_staff_id_key"
    ON "office_intercom_receipts"("broadcast_id", "staff_id");

CREATE INDEX "office_intercom_receipts_staff_id_confirmed_at_idx"
    ON "office_intercom_receipts"("staff_id", "confirmed_at");

ALTER TABLE "office_intercom_receipts"
    ADD CONSTRAINT "office_intercom_receipts_broadcast_id_fkey"
    FOREIGN KEY ("broadcast_id") REFERENCES "office_intercom_broadcasts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
