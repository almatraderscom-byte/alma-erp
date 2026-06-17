-- Phase 1: agent-captured context screenshot URL for staff task Details button
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS context_shot TEXT;
