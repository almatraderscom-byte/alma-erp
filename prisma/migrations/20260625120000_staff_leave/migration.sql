-- Per-staff leave / sick days (approved leave skips absent, fines, tasks)
CREATE TABLE "staff_leave" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "staff_name" TEXT,
    "business_id" TEXT,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'leave',
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" TEXT,

    CONSTRAINT "staff_leave_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "staff_leave_staff_id_start_date_idx" ON "staff_leave"("staff_id", "start_date");
