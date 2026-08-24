-- Expand-only, rollback-safe durable artifact delivery.
-- Rollback is AGENT_ARTIFACT_OUTBOX=false; legacy rows remain readable and no
-- existing artifact/message is deleted or made non-null.
ALTER TABLE "agent_artifacts"
  ADD COLUMN IF NOT EXISTS "delivery_key" TEXT,
  ADD COLUMN IF NOT EXISTS "content_sha256" TEXT,
  ADD COLUMN IF NOT EXISTS "storage_path" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_artifacts_delivery_key_key"
  ON "agent_artifacts"("delivery_key");

CREATE TABLE IF NOT EXISTS "agent_artifact_delivery_outbox" (
  "id" TEXT NOT NULL,
  "delivery_key" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "logical_name" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "spec" JSONB NOT NULL,
  "storage_receipts" JSONB,
  "artifact_id" TEXT,
  "message_id" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" TIMESTAMP(3),
  "lease_owner" TEXT,
  "last_error" TEXT,
  "delivered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_artifact_delivery_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_artifact_delivery_outbox_delivery_key_key"
  ON "agent_artifact_delivery_outbox"("delivery_key");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_artifact_delivery_outbox_source_kind_source_id_logical_name_version_key"
  ON "agent_artifact_delivery_outbox"("source_kind", "source_id", "logical_name", "version");
CREATE INDEX IF NOT EXISTS "agent_artifact_delivery_outbox_status_available_at_lease_until_idx"
  ON "agent_artifact_delivery_outbox"("status", "available_at", "lease_until");
CREATE INDEX IF NOT EXISTS "agent_artifact_delivery_outbox_source_kind_source_id_idx"
  ON "agent_artifact_delivery_outbox"("source_kind", "source_id");

CREATE TABLE IF NOT EXISTS "agent_artifact_delivery_ledger" (
  "id" TEXT NOT NULL,
  "outbox_id" TEXT NOT NULL,
  "milestone" TEXT NOT NULL,
  "payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_artifact_delivery_ledger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_artifact_delivery_ledger_outbox_id_milestone_key"
  ON "agent_artifact_delivery_ledger"("outbox_id", "milestone");
CREATE INDEX IF NOT EXISTS "agent_artifact_delivery_ledger_outbox_id_created_at_idx"
  ON "agent_artifact_delivery_ledger"("outbox_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "agent_artifact_delivery_ledger"
    ADD CONSTRAINT "agent_artifact_delivery_ledger_outbox_id_fkey"
    FOREIGN KEY ("outbox_id") REFERENCES "agent_artifact_delivery_outbox"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Expand/backfill: executed SEO audits that predate this table still owe the
-- same durable card. This includes partially delivered rows (artifact exists,
-- message/link missing); the dispatcher adopts matching content and converges.
-- No existing action/artifact/message is changed by the migration itself.
WITH eligible AS (
  SELECT
    action."id",
    COALESCE(action."resolvedAt", action."createdAt") AS "settledAt"
  FROM "agent_pending_actions" action
  JOIN "agent_conversations" conversation
    ON conversation."id" = COALESCE(
      NULLIF(BTRIM(action."conversationId"::text), ''),
      NULLIF(BTRIM(action."payload"->>'conversationId'), '')
    )
  WHERE action."type" = 'seo_audit'
    AND action."status" = 'executed'
    AND action."result" IS NOT NULL
    AND action."result"::text LIKE '%audit.json%'
),
candidate_ids AS (
  SELECT recent."id"
  FROM (
    SELECT eligible."id"
    FROM eligible
    ORDER BY eligible."settledAt" DESC
    LIMIT 500
  ) recent
  UNION
  -- Sanitized incident source identity: always include it even after the
  -- rolling cohort ages past the bounded recent window.
  SELECT eligible."id"
  FROM eligible
  WHERE eligible."id" = '2617c17a-079f-4f6b-b49e-060e23f4380a'
)
INSERT INTO "agent_artifact_delivery_outbox" (
  "id", "delivery_key", "source_kind", "source_id", "conversation_id",
  "logical_name", "version", "status", "spec", "available_at",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  'artifact:pending_action:' || action."id"::text || ':seo-dashboard:v1',
  'pending_action',
  action."id"::text,
  COALESCE(
    NULLIF(BTRIM(action."conversationId"::text), ''),
    NULLIF(BTRIM(action."payload"->>'conversationId'), '')
  ),
  'seo-dashboard',
  1,
  'pending',
  jsonb_build_object('kind', 'seo_audit', 'sourceActionId', action."id"::text, 'version', 1, 'backfilled', true),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "agent_pending_actions" action
JOIN candidate_ids candidate ON candidate."id" = action."id"
JOIN "agent_conversations" conversation
  ON conversation."id" = COALESCE(
    NULLIF(BTRIM(action."conversationId"::text), ''),
    NULLIF(BTRIM(action."payload"->>'conversationId'), '')
  )
WHERE action."type" = 'seo_audit'
  AND action."status" = 'executed'
  AND COALESCE(
    NULLIF(BTRIM(action."conversationId"::text), ''),
    NULLIF(BTRIM(action."payload"->>'conversationId'), '')
  ) IS NOT NULL
  AND action."result" IS NOT NULL
  AND action."result"::text LIKE '%audit.json%'
ON CONFLICT DO NOTHING;

INSERT INTO "agent_artifact_delivery_ledger" ("id", "outbox_id", "milestone", "payload")
SELECT
  gen_random_uuid()::text,
  outbox."id",
  'enqueued',
  jsonb_build_object('sourceKind', outbox."source_kind", 'sourceId', outbox."source_id", 'backfilled', true)
FROM "agent_artifact_delivery_outbox" outbox
WHERE outbox."source_kind" = 'pending_action'
  AND outbox."logical_name" = 'seo-dashboard'
  AND outbox."version" = 1
  AND outbox."spec"->>'backfilled' = 'true'
ON CONFLICT ("outbox_id", "milestone") DO NOTHING;
