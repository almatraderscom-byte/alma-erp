-- Task B (graph-memory, cognee-style): a light triple store layered OVER the
-- agent's existing semantic memory. Each row is one directed relationship
-- (subject -predicate-> object) connecting business entities — customer, order,
-- staff, product, topic — so the agent can do entity-centric recall ("everything
-- I know about this customer") by traversing edges, which flat vector search
-- cannot do. Business-scoped, additive, idempotent. Does NOT touch ERP tables;
-- structured ERP joins still live in the live DB — this stores the agent's
-- LEARNED cross-entity knowledge only.
CREATE TABLE IF NOT EXISTS "agent_knowledge_edge" (
  "id"            TEXT NOT NULL,
  "subject_type"  TEXT NOT NULL,
  "subject_id"    TEXT NOT NULL,
  "subject_label" TEXT,
  "predicate"     TEXT NOT NULL,
  "object_type"   TEXT NOT NULL,
  "object_id"     TEXT NOT NULL,
  "object_label"  TEXT,
  "weight"        INTEGER NOT NULL DEFAULT 1,
  "note"          TEXT,
  "business_id"   TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
  "metadata"      JSONB,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"  TIMESTAMP(3),
  CONSTRAINT "agent_knowledge_edge_pkey" PRIMARY KEY ("id")
);

-- One triple per business is a single reinforced row (weight bumped on repeat),
-- never duplicated. This unique key backs the upsert in knowledge-graph.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_knowledge_edge_triple_uq"
  ON "agent_knowledge_edge"("business_id", "subject_type", "subject_id", "predicate", "object_type", "object_id");

-- Outgoing traversal: find edges where an entity is the subject.
CREATE INDEX IF NOT EXISTS "agent_knowledge_edge_subject_idx"
  ON "agent_knowledge_edge"("business_id", "subject_type", "subject_id");

-- Incoming traversal: find edges where an entity is the object.
CREATE INDEX IF NOT EXISTS "agent_knowledge_edge_object_idx"
  ON "agent_knowledge_edge"("business_id", "object_type", "object_id");
