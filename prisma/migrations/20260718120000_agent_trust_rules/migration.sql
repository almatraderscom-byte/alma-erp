-- agent_trust_rules — schema existed in Prisma but migration was missing (trust UI + engine).
CREATE TABLE IF NOT EXISTS "agent_trust_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain" TEXT NOT NULL,
    "action_pattern" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'approve',
    "conditions" JSONB,
    "approval_count" INTEGER NOT NULL DEFAULT 0,
    "rejection_count" INTEGER NOT NULL DEFAULT 0,
    "consecutive_approvals" INTEGER NOT NULL DEFAULT 0,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
    "last_promoted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_trust_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_trust_rules_domain_action_pattern_business_id_key"
  ON "agent_trust_rules"("domain", "action_pattern", "business_id");

CREATE INDEX IF NOT EXISTS "agent_trust_rules_business_id_tier_idx"
  ON "agent_trust_rules"("business_id", "tier");
