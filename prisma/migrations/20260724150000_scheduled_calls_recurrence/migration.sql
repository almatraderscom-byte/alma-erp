-- Human-PA point 4: recurring calls ("প্রতিদিন রাত ৯টায় কল করে দিনের সারাংশ").
-- Additive: recurrence = null (one-off) | 'daily' | 'weekdays' | 'weekly'.
ALTER TABLE "scheduled_calls" ADD COLUMN "recurrence" TEXT;
