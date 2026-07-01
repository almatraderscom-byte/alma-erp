-- CreateTable
CREATE TABLE "agent_content_calendar" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "platform" TEXT NOT NULL,
    "page_ref" TEXT NOT NULL DEFAULT 'lifestyle',
    "caption" TEXT NOT NULL,
    "image_ref" TEXT,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "post_id" TEXT,
    "permalink_url" TEXT,
    "error" TEXT,
    "conversation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),

    CONSTRAINT "agent_content_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_content_calendar_status_scheduled_for_idx" ON "agent_content_calendar"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "agent_content_calendar_business_id_status_idx" ON "agent_content_calendar"("business_id", "status");

-- CreateIndex
CREATE INDEX "agent_content_calendar_conversation_id_idx" ON "agent_content_calendar"("conversation_id");
