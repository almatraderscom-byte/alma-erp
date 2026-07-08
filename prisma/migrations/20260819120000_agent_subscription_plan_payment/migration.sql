-- Native Subscriptions screen (2026-07): manual-tracker fields.
-- Additive only — both columns are nullable, so existing rows are unaffected.
ALTER TABLE "agent_subscriptions" ADD COLUMN "plan" TEXT;
ALTER TABLE "agent_subscriptions" ADD COLUMN "payment_method" TEXT;
