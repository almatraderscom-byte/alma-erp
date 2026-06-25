-- Personal Life Tier 2: appointments, medications, health logs, documents, marketing nudges.
-- Additive only. All idempotent (IF NOT EXISTS) so re-applying on production is safe.

-- #6 Calendar / appointments (with salah deconflict awareness in the tool layer).
CREATE TABLE IF NOT EXISTS "agent_appointments" (
  "id"                    TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "title"                 TEXT NOT NULL,
  "location"              TEXT,
  "start_at"              TIMESTAMP(3) NOT NULL,
  "end_at"                TIMESTAMP(3),
  "type"                  TEXT NOT NULL DEFAULT 'meeting',
  "status"                TEXT NOT NULL DEFAULT 'scheduled',
  "remind_minutes_before" INTEGER NOT NULL DEFAULT 60,
  "reminder_id"           TEXT,
  "notes"                 TEXT,
  "last_reminded_at"      TIMESTAMP(3),
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_appointments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_appointments_status_start_at_idx" ON "agent_appointments" ("status", "start_at");

-- #9 Medication schedule.
CREATE TABLE IF NOT EXISTS "agent_medications" (
  "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name"             TEXT NOT NULL,
  "dosage"           TEXT,
  "times"            TEXT,
  "frequency"        TEXT NOT NULL DEFAULT 'daily',
  "start_date"       DATE,
  "end_date"         DATE,
  "active"           BOOLEAN NOT NULL DEFAULT true,
  "notes"            TEXT,
  "last_reminded_at" TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_medications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_medications_active_idx" ON "agent_medications" ("active");

-- #9 Health logs (weight, BP, sugar, etc.).
CREATE TABLE IF NOT EXISTS "agent_health_logs" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "type"       TEXT NOT NULL,
  "value"      TEXT,
  "unit"       TEXT,
  "note"       TEXT,
  "logged_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_health_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_health_logs_type_logged_at_idx" ON "agent_health_logs" ("type", "logged_at");

-- #8 Document / receipt vault (OCR extracted).
CREATE TABLE IF NOT EXISTS "agent_documents" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "title"       TEXT NOT NULL,
  "type"        TEXT NOT NULL DEFAULT 'receipt',
  "category"    TEXT,
  "object_path" TEXT,
  "mime_type"   TEXT,
  "ocr_text"    TEXT,
  "vendor"      TEXT,
  "amount"      INTEGER,
  "doc_date"    DATE,
  "tags"        TEXT,
  "notes"       TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_documents_type_created_at_idx" ON "agent_documents" ("type", "created_at");

-- #11 Festival / Eid marketing nudges (dedupe so each festival fires once).
CREATE TABLE IF NOT EXISTS "agent_marketing_nudges" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "festival_key"  TEXT NOT NULL,
  "festival_name" TEXT,
  "festival_date" DATE,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_marketing_nudges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_marketing_nudges_festival_key_key" ON "agent_marketing_nudges" ("festival_key");
