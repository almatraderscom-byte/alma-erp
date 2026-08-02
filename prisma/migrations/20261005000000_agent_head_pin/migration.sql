-- P0-1 (agent foundation audit): task-level head-model pin.
-- Head routing was decided per MESSAGE, so a single job could start on the heavy
-- head and finish on the cheap one (owner-visible: the badge changed mid-task).
-- The pin is the job's model, taken once and held until it expires; it may only
-- escalate (light -> heavy), never downgrade, so a money message can never be
-- kept on a cheap head by an older pin.
ALTER TABLE "agent_conversations" ADD COLUMN "pinned_head_model" TEXT;
ALTER TABLE "agent_conversations" ADD COLUMN "pinned_head_tier" TEXT;
ALTER TABLE "agent_conversations" ADD COLUMN "pinned_head_via" TEXT;
ALTER TABLE "agent_conversations" ADD COLUMN "pinned_head_until" TIMESTAMP(3);
