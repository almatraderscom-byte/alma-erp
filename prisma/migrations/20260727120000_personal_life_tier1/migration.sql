-- Personal Life Tier 1: bills/subscriptions tracker + important dates / Islamic calendar.
-- Additive only. Both tables are agent-owned (personal autonomy), keyed off the owner.

-- Recurring bills & subscriptions the owner wants tracked (rent, utilities, SaaS, loans…).
-- Money stored as whole-taka INTEGER (ERP money rule) — currency defaults to BDT.
CREATE TABLE IF NOT EXISTS "agent_bills" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "amount" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'BDT',
  "category" TEXT,
  "cycle" TEXT NOT NULL DEFAULT 'monthly',
  "due_day" INTEGER,
  "next_due_at" DATE,
  "remind_days_before" INTEGER NOT NULL DEFAULT 3,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "last_reminded_at" TIMESTAMP(3),
  "last_paid_at" TIMESTAMP(3),
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_bills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_bills_active_due_idx"
  ON "agent_bills" ("active", "next_due_at");

-- Important dates: birthdays, anniversaries, Islamic/Gregorian recurring events, deadlines.
CREATE TABLE IF NOT EXISTS "agent_important_dates" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'custom',
  "event_date" DATE NOT NULL,
  "recurring" BOOLEAN NOT NULL DEFAULT true,
  "calendar" TEXT NOT NULL DEFAULT 'gregorian',
  "related_name" TEXT,
  "remind_days_before" INTEGER NOT NULL DEFAULT 1,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "last_reminded_at" TIMESTAMP(3),
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_important_dates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_important_dates_active_idx"
  ON "agent_important_dates" ("active", "event_date");
