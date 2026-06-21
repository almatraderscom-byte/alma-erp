-- B2: per-message embeddings + true RAG recall of old turns.
--
-- Each user/assistant message gets an embedding so the head can semantically
-- recall turns that have aged out of the verbatim history window (the most
-- recent ~30 turns stay verbatim; older ones are recalled on demand). The
-- pgvector extension was already installed by 20260611120000_agent_memory_pgvector.
--
-- Additive + idempotent (IF NOT EXISTS): safe to re-run; no existing data touched.
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "summary" TEXT;

-- HNSW for fast cosine recall (matches agent_memory). If HNSW is unavailable on
-- the target pgvector build, run the ivfflat fallback manually:
--   CREATE INDEX IF NOT EXISTS "agent_messages_embedding_ivfflat_idx"
--     ON "agent_messages" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS "agent_messages_embedding_hnsw_idx"
  ON "agent_messages" USING hnsw ("embedding" vector_cosine_ops);
