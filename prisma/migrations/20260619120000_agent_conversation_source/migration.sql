-- Add source column to distinguish web vs Telegram agent conversations
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web';

CREATE INDEX IF NOT EXISTS agent_conversations_source_idx ON agent_conversations(source);

-- Backfill known Telegram daily conversations by title pattern
UPDATE agent_conversations SET source = 'telegram' WHERE title LIKE 'Telegram %' AND source = 'web';
