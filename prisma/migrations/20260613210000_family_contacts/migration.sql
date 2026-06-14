-- Family contacts for Personal Advisor mode (additive only)
CREATE TABLE IF NOT EXISTS "family_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" TEXT,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_contacts_pkey" PRIMARY KEY ("id")
);
