-- CS-2: comment capture, follow-ups, repeat customers, guards

ALTER TABLE "cs_conversations"
  ADD COLUMN IF NOT EXISTS "last_customer_message_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "agent_replies_today" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "agent_replies_reset_date" TEXT,
  ADD COLUMN IF NOT EXISTS "abuse_warned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "loop_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_question_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "lost_sale_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "cs_order_drafts"
  ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "confirmed_by" TEXT,
  ADD COLUMN IF NOT EXISTS "cod_amount" INTEGER,
  ADD COLUMN IF NOT EXISTS "erp_order_id" TEXT;

CREATE TABLE IF NOT EXISTS "cs_post_products" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "post_id" TEXT NOT NULL,
  "page_id" TEXT NOT NULL,
  "product_codes" JSONB NOT NULL DEFAULT '[]',
  "business" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "cs_post_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cs_post_products_post_page_key" ON "cs_post_products"("post_id", "page_id");
CREATE INDEX IF NOT EXISTS "cs_post_products_page_id_idx" ON "cs_post_products"("page_id");

CREATE TABLE IF NOT EXISTS "cs_customers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "psid" TEXT NOT NULL,
  "page_id" TEXT NOT NULL,
  "name" TEXT,
  "phone" TEXT,
  "address_last" TEXT,
  "sizes_noted" JSONB NOT NULL DEFAULT '{}',
  "orders_count" INTEGER NOT NULL DEFAULT 0,
  "last_order_at" TIMESTAMPTZ,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "cs_customers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cs_customers_page_psid_key" ON "cs_customers"("page_id", "psid");
CREATE INDEX IF NOT EXISTS "cs_customers_phone_idx" ON "cs_customers"("phone");

CREATE TABLE IF NOT EXISTS "cs_followups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "scheduled_at" TIMESTAMPTZ NOT NULL,
  "sent_at" TIMESTAMPTZ,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "message_text" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "cs_followups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cs_followups_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "cs_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "cs_followups_status_scheduled_idx" ON "cs_followups"("status", "scheduled_at");
CREATE INDEX IF NOT EXISTS "cs_followups_conversation_id_idx" ON "cs_followups"("conversation_id");

CREATE TABLE IF NOT EXISTS "cs_comment_replies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "comment_id" TEXT NOT NULL,
  "post_id" TEXT NOT NULL,
  "page_id" TEXT NOT NULL,
  "psid" TEXT NOT NULL,
  "private_replied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "public_replied" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "cs_comment_replies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cs_comment_replies_comment_id_key" ON "cs_comment_replies"("comment_id");
CREATE INDEX IF NOT EXISTS "cs_comment_replies_post_psid_idx" ON "cs_comment_replies"("post_id", "psid");

CREATE TABLE IF NOT EXISTS "cs_blocks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "page_id" TEXT NOT NULL,
  "psid" TEXT NOT NULL,
  "reason" TEXT,
  "blocked_by" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "cs_blocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cs_blocks_page_psid_key" ON "cs_blocks"("page_id", "psid");

CREATE TABLE IF NOT EXISTS "cs_analytics_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" TEXT NOT NULL,
  "conversation_id" UUID,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "cs_analytics_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cs_analytics_events_kind_created_idx" ON "cs_analytics_events"("kind", "created_at");

INSERT INTO "agent_kv_settings" ("key", "value")
VALUES ('cs_public_comment_reply', 'false')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "agent_kv_settings" ("key", "value")
VALUES ('cs_followups_enabled', 'true')
ON CONFLICT ("key") DO NOTHING;
