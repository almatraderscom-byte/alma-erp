CREATE TABLE IF NOT EXISTS "agent_creative_performance" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id"    TEXT         NOT NULL,
    "campaign_name"  TEXT,
    "ad_id"          TEXT,
    "angle"          TEXT         NOT NULL,
    "product_code"   TEXT,
    "roas"           DOUBLE PRECISION,
    "ctr"            DOUBLE PRECISION,
    "spend_bdt"      INTEGER,
    "verdict"        TEXT,
    "recorded_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_creative_performance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_creative_performance_campaign_id_idx"
  ON "agent_creative_performance"("campaign_id");

CREATE INDEX IF NOT EXISTS "agent_creative_performance_angle_idx"
  ON "agent_creative_performance"("angle");

CREATE INDEX IF NOT EXISTS "agent_creative_performance_recorded_at_idx"
  ON "agent_creative_performance"("recorded_at" DESC);
