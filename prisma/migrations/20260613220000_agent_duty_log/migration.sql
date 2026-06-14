-- Agent daily duty log for self-monitor (additive only)
CREATE TABLE IF NOT EXISTS "agent_duty_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "duty" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "duty_date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,
    "ran_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_duty_log_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_duty_log_duty_duty_date_key" ON "agent_duty_log"("duty", "duty_date");
CREATE INDEX IF NOT EXISTS "agent_duty_log_duty_date_idx" ON "agent_duty_log"("duty_date");
