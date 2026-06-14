-- Intelligence B: structured business knowledge graph
CREATE TABLE IF NOT EXISTS "agent_knowledge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "entity_name" TEXT,
    "attribute" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidence_count" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_knowledge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_knowledge_entity_type_entity_id_attribute_key"
    ON "agent_knowledge"("entity_type", "entity_id", "attribute");

CREATE INDEX IF NOT EXISTS "agent_knowledge_entity_type_idx" ON "agent_knowledge"("entity_type");
