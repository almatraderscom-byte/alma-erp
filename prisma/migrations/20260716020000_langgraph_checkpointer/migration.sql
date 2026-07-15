-- LG-2: LangGraph Postgres checkpointer tables (docs/langgraph-adoption-roadmap.md).
--
-- Schema/DDL mirrors @langchain/langgraph-checkpoint-postgres v0.x migrations
-- 0..4 EXACTLY (with v4's "blob DROP NOT NULL" folded into the CREATE), kept in
-- a dedicated `langgraph` schema so the ERP's public schema stays clean.
-- The library's own migration ledger (checkpoint_migrations) is pre-seeded with
-- versions 0..4 so a stray PostgresSaver.setup() call is a guaranteed no-op —
-- the project's Prisma migration system stays the single owner of DDL
-- (project rule: never introduce a second migration system).
--
-- ALMA additions on top of the library shape (additive, insert-safe because the
-- library upserts with explicit column lists):
--   * created_at columns  → TTL cleanup (stale threads deleted after N days)
--   * created_at / thread_id indexes for the cleanup + resume queries

CREATE SCHEMA IF NOT EXISTS "langgraph";

CREATE TABLE IF NOT EXISTS "langgraph"."checkpoint_migrations" (
    v INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS "langgraph"."checkpoints" (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS "langgraph"."checkpoint_blobs" (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    blob BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS "langgraph"."checkpoint_writes" (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    blob BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

-- Pre-seed the library ledger: versions 0..4 (the DDL above) are applied.
INSERT INTO "langgraph"."checkpoint_migrations" (v)
VALUES (0), (1), (2), (3), (4)
ON CONFLICT (v) DO NOTHING;

-- TTL cleanup scans by age; resume/statehistory scans by thread.
CREATE INDEX IF NOT EXISTS "checkpoints_created_at_idx"
    ON "langgraph"."checkpoints" (created_at);
CREATE INDEX IF NOT EXISTS "checkpoint_blobs_thread_idx"
    ON "langgraph"."checkpoint_blobs" (thread_id);
CREATE INDEX IF NOT EXISTS "checkpoint_writes_thread_idx"
    ON "langgraph"."checkpoint_writes" (thread_id);
