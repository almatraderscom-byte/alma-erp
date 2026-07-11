-- Answer Gate (owner decision 2026-07-08): verified reusable Q&A pairs served
-- in front of EXPENSIVE heads only. Additive — no existing table touched.
CREATE TABLE IF NOT EXISTS "agent_qa_cache" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'business',
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "embedding" vector(1536),
    "source_model" TEXT,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "last_served_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_qa_cache_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_qa_cache_scope_active_idx" ON "agent_qa_cache"("scope", "active");
