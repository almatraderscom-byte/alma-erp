-- CS-1: Customer sales agent (additive only)

CREATE TABLE "cs_conversations" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "fb_conversation_id" TEXT,
    "customer_name" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'open',
    "failed_match_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_cs_reply_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cs_conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cs_conversations_page_psid_key" ON "cs_conversations"("page_id", "psid");
CREATE INDEX "cs_conversations_last_message_at_idx" ON "cs_conversations"("last_message_at" DESC);
CREATE INDEX "cs_conversations_status_idx" ON "cs_conversations"("status");

CREATE TABLE "cs_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '[]',
    "meta_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cs_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cs_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "cs_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "cs_messages_conversation_id_created_at_idx" ON "cs_messages"("conversation_id", "created_at");

CREATE TABLE "product_visual_index" (
    "id" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "business" TEXT NOT NULL,
    "image_url" TEXT,
    "storage_path" TEXT,
    "description" TEXT NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "indexed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_visual_index_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_visual_index_product_business_key" ON "product_visual_index"("product_code", "business");
CREATE INDEX "product_visual_index_business_idx" ON "product_visual_index"("business");

-- pgvector column (same pattern as agent_memory)
ALTER TABLE "product_visual_index" ADD COLUMN "embedding" vector(1536);

CREATE INDEX IF NOT EXISTS "product_visual_index_embedding_hnsw_idx"
  ON "product_visual_index" USING hnsw ("embedding" vector_cosine_ops);

CREATE TABLE "cs_order_drafts" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "customer_name" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cs_order_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cs_order_drafts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "cs_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "cs_order_drafts_conversation_id_idx" ON "cs_order_drafts"("conversation_id");
CREATE INDEX "cs_order_drafts_status_idx" ON "cs_order_drafts"("status");

CREATE TABLE "cs_shadow_drafts" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "draft_text" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "escalation_stage" TEXT NOT NULL DEFAULT 'none',
    "assigned_staff_id" TEXT,
    "sent_at" TIMESTAMPTZ,
    "acknowledged_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cs_shadow_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cs_shadow_drafts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "cs_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "cs_shadow_drafts_status_created_at_idx" ON "cs_shadow_drafts"("status", "created_at");
CREATE INDEX "cs_shadow_drafts_escalation_stage_idx" ON "cs_shadow_drafts"("escalation_stage");

CREATE TABLE "cs_reply_jobs" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    CONSTRAINT "cs_reply_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cs_reply_jobs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "cs_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "cs_reply_jobs_message_id_key" ON "cs_reply_jobs"("message_id");
CREATE INDEX "cs_reply_jobs_status_created_at_idx" ON "cs_reply_jobs"("status", "created_at");

-- Default CS mode: off until owner enables
INSERT INTO "agent_kv_settings" ("key", "value", "updated_at")
VALUES ('cs_mode', 'off', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
