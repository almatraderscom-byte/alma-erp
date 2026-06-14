-- Agent conversation session summarization tracking
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS summarized_at TIMESTAMPTZ;
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
