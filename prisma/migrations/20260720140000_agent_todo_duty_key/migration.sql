-- Phase A: link agent_todos rows 1:1 with daily duty roster keys
ALTER TABLE "agent_todos" ADD COLUMN IF NOT EXISTS "duty_key" TEXT;

CREATE INDEX IF NOT EXISTS "agent_todos_business_id_duty_key_due_date_idx"
  ON "agent_todos"("business_id", "duty_key", "due_date");
