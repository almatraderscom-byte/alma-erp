-- Per-business payroll hold (additive): cron and manual runs skip held businesses
ALTER TABLE "PayrollAutomationSetting" ADD COLUMN "heldBusinessIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
