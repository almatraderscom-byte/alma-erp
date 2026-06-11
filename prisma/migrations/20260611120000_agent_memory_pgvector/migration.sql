-- Phase 3: pgvector semantic memory
-- NOTE: This migration requires pgvector extension.
-- If CREATE EXTENSION fails (e.g. on Supabase free tier without pgvector),
-- run this SQL manually in the Supabase dashboard first:
--   CREATE EXTENSION IF NOT EXISTS vector;
-- All other steps degrade gracefully until then.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "agent_memory" ADD COLUMN "embedding" vector(1536);

-- Try HNSW index first (faster queries, requires pgvector >= 0.5).
-- If this fails, run ivfflat instead (see comment below).
CREATE INDEX IF NOT EXISTS "agent_memory_embedding_hnsw_idx"
  ON "agent_memory" USING hnsw ("embedding" vector_cosine_ops);

-- Fallback ivfflat (run manually if hnsw fails):
-- CREATE INDEX IF NOT EXISTS "agent_memory_embedding_ivfflat_idx"
--   ON "agent_memory" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
