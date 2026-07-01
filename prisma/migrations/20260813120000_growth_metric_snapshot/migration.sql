-- Growth Autopilot: weekly analytics snapshot (ads spend/ROAS, content cadence, catalog health).
-- One row per digest run so week-over-week history builds up over time. Additive only.
CREATE TABLE "agent_growth_metric" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "source" TEXT NOT NULL DEFAULT 'weekly_digest',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_growth_metric_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_growth_metric_business_id_period_start_idx" ON "agent_growth_metric"("business_id", "period_start");
CREATE INDEX "agent_growth_metric_source_period_start_idx" ON "agent_growth_metric"("source", "period_start");
