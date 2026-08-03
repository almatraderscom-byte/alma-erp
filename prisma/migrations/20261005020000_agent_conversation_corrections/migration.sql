-- P0-4 (agent foundation audit): the owner's corrections, kept out of the
-- transcript. A correction used to compete for attention with every other line
-- of history; stored here it can lead the next turn's context instead.
ALTER TABLE "agent_conversations" ADD COLUMN "corrections" JSONB;
