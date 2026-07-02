-- Known-people registry for camera face identification (entrance watch +
-- work-room naming). Additive only — no existing table is touched.
CREATE TABLE IF NOT EXISTS "agent_known_people" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'staff',
    "photo_paths" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_known_people_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_known_people_business_id_active_idx"
    ON "agent_known_people"("business_id", "active");
