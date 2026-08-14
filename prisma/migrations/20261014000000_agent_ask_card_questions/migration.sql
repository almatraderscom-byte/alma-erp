-- Multi-question ask card (Claude-Code-style batched questions).
-- Additive only: NULL for every existing single-question card.
ALTER TABLE "agent_ask_cards" ADD COLUMN IF NOT EXISTS "questions" TEXT;
