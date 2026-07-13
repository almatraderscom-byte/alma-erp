-- Owner personal receivable/payable khata (পাওনা-দেনা), owner decision 2026-07-13.
-- Additive only — no existing table touched.
CREATE TYPE "PersonalLedgerDirection" AS ENUM ('OUT', 'IN');

CREATE TABLE IF NOT EXISTS "personal_ledger_parties" (
    "id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "note" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_ledger_parties_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "personal_ledger_txns" (
    "id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "direction" "PersonalLedgerDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "txn_date" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "edit_history" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_ledger_txns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "personal_ledger_parties_owner_user_id_archived_at_idx"
    ON "personal_ledger_parties"("owner_user_id", "archived_at");

CREATE INDEX IF NOT EXISTS "personal_ledger_txns_party_id_deleted_at_txn_date_idx"
    ON "personal_ledger_txns"("party_id", "deleted_at", "txn_date");

ALTER TABLE "personal_ledger_txns"
    ADD CONSTRAINT "personal_ledger_txns_party_id_fkey"
    FOREIGN KEY ("party_id") REFERENCES "personal_ledger_parties"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
