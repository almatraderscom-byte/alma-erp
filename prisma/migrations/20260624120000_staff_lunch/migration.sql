-- Staff lunch tracking (45 min allowance + escalation)
CREATE TABLE "staff_lunch" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "staff_name" TEXT,
    "lunch_date" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_min" INTEGER,
    "overage" BOOLEAN NOT NULL DEFAULT false,
    "warned_45" BOOLEAN NOT NULL DEFAULT false,
    "alerted_60" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "staff_lunch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "staff_lunch_staff_id_lunch_date_idx" ON "staff_lunch"("staff_id", "lunch_date");
