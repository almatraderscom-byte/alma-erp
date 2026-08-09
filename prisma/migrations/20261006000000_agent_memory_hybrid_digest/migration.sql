-- Memory upgrade (owner-approved 2026-08-03, ideas borrowed from TencentDB-Agent-Memory,
-- rebuilt on our own Postgres so no extra service/container is introduced).
--
-- Two additive pieces:
--
-- 1. HYBRID RETRIEVAL. Until now recall was vector-only, so an exact token the
--    embedding does not preserve — an order id, a phone number, a person's name,
--    a product code — was often missed. A keyword arm is added alongside the
--    vector arm and the two are fused (RRF) in application code.
--    Bangla note: Postgres has no Bangla text-search dictionary, so the 'simple'
--    configuration is used deliberately — it lowercases and splits on Unicode
--    word boundaries WITHOUT stemming, which is correct for Bangla and Banglish
--    alike. pg_trgm covers partial/typo matches (and digits) on top of that.
--
-- 2. DIGEST LAYERS (L2 scenario / L3 persona). Flat facts alone force the head to
--    re-derive the same picture every turn. A weekly job distills the fact rows
--    into a handful of scenario blocks and one standing persona block per scope,
--    which are retrieved first and cost far fewer tokens than the facts they
--    summarise. Derived data only — rebuilt from agent_memory, never authored by
--    hand, so it is always safe to delete and regenerate.

-- ── 1. Hybrid retrieval indexes on the existing fact table ───────────────────

-- Full-text arm ('simple' = no stemming; safe for Bangla + English + Banglish).
-- Needs no extension, so it is created unconditionally.
CREATE INDEX IF NOT EXISTS "agent_memory_content_tsv_idx"
  ON "agent_memory" USING gin (to_tsvector('simple', "content"));

-- Trigram arm: accelerates ILIKE '%token%' for ids, numbers and partial words.
-- Guarded on purpose. This migration runs during a PRODUCTION deploy of a live
-- ERP, and CREATE EXTENSION needs a privilege the database role may not have. A
-- missing pg_trgm must degrade to "ILIKE without an index" (correct, just slower
-- on a table this size) — it must never fail the deploy.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm could not be created (%): trigram index skipped', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "agent_memory_content_trgm_idx"
               ON "agent_memory" USING gin ("content" gin_trgm_ops)';
  END IF;
END $$;

-- ── 2. Digest layers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "agent_memory_digest" (
  "id"            TEXT NOT NULL,
  -- 'L2' = scenario block (one topic), 'L3' = standing persona block (one per scope family)
  "layer"         TEXT NOT NULL,
  -- 'personal' | 'business' — which retrieval mode the block belongs to
  "scope"         TEXT NOT NULL,
  -- NULL for personal blocks; 'ALMA_LIFESTYLE' | 'ALMA_TRADING' for business blocks
  "business_id"   TEXT,
  "topic"         TEXT NOT NULL,
  "content"       TEXT NOT NULL,
  "embedding"     vector(1536),
  "source_count"  INTEGER NOT NULL DEFAULT 0,
  "source_ids"    JSONB,
  "refreshed_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_memory_digest_pkey" PRIMARY KEY ("id")
);

-- One block per (layer, scope, business, topic): a rebuild replaces in place.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_memory_digest_slot_key"
  ON "agent_memory_digest" ("layer", "scope", COALESCE("business_id", ''), "topic");

CREATE INDEX IF NOT EXISTS "agent_memory_digest_layer_scope_idx"
  ON "agent_memory_digest" ("layer", "scope");

-- Vector index for L2 topic matching (same style as agent_memory).
-- Fallback if hnsw is unavailable on the target pgvector build:
--   CREATE INDEX IF NOT EXISTS "agent_memory_digest_embedding_ivfflat_idx"
--     ON "agent_memory_digest" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS "agent_memory_digest_embedding_hnsw_idx"
  ON "agent_memory_digest" USING hnsw ("embedding" vector_cosine_ops);
