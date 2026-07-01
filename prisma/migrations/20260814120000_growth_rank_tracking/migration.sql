-- Growth Autopilot: keyword rank tracking. Additive only.
-- agent_tracked_keyword: keywords the owner wants monitored in Google (BD).
-- agent_keyword_rank: one SERP observation per (keyword, run) over time.
CREATE TABLE "agent_tracked_keyword" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "keyword" TEXT NOT NULL,
    "product_slug" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tracked_keyword_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_tracked_keyword_business_id_keyword_key" ON "agent_tracked_keyword"("business_id", "keyword");
CREATE INDEX "agent_tracked_keyword_active_idx" ON "agent_tracked_keyword"("active");

CREATE TABLE "agent_keyword_rank" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "keyword" TEXT NOT NULL,
    "product_slug" TEXT,
    "rank" INTEGER,
    "url" TEXT,
    "found_in_top10" BOOLEAN NOT NULL DEFAULT false,
    "top10" JSONB,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_keyword_rank_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_keyword_rank_keyword_checked_at_idx" ON "agent_keyword_rank"("keyword", "checked_at");
CREATE INDEX "agent_keyword_rank_business_id_checked_at_idx" ON "agent_keyword_rank"("business_id", "checked_at");
