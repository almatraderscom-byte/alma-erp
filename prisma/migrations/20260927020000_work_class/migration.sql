-- A job keeps its size (owner, live 2026-07-27).
--
-- The turn's work class (chat | deep | long_run) drives both the round cap and
-- the head's tool budget, and it was derived from the LATEST message alone. So
-- "almatraders.com এর পুরো … ঠিক করে দাও" earned 60 rounds, and tapping
-- "হ্যাঁ, এখনই শুরু করুন" on the agent's own card earned 8 — the same job, two
-- sizes, and the small one always won at exactly the moment the work began.
--
-- The class is now remembered for the job, with an expiry so it cannot leak into
-- next week's chat. Additive; NULL everywhere means today's behaviour.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "work_class" TEXT;

ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "work_class_until" TIMESTAMPTZ;
