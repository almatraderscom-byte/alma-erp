-- Intercom call lifecycle: cancel / decline / missed / complete signalling +
-- bidirectional (staff → owner) call targeting. Additive only — every column is
-- nullable, so existing rows and the live walkie-talkie path are untouched.

ALTER TABLE "office_intercom_broadcasts"
    ADD COLUMN "target_user_id" TEXT,
    ADD COLUMN "caller_name"    TEXT,
    ADD COLUMN "ended_at"       TIMESTAMP(3),
    ADD COLUMN "ended_reason"   TEXT;

-- A callee client polls "is there a live call still ringing for me": index the
-- lookup by target + freshness so the poll stays cheap as history grows.
CREATE INDEX "office_intercom_broadcasts_target_user_id_created_at_idx"
    ON "office_intercom_broadcasts"("target_user_id", "created_at" DESC);
