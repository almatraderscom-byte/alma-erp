-- Agent Module Phase 0: six new tables for the personal AI agent module.
-- These tables are additive-only. No existing tables are modified.
-- Timestamps use TIMESTAMP(3) to match the project's Prisma convention.
-- IDs are UUID (gen_random_uuid()) as specified in the phase prompt.
-- Table names are snake_case via Prisma @@map(); column names are camelCase (Prisma default).

CREATE TABLE "agent_projects" (
    "id"                 UUID          NOT NULL DEFAULT gen_random_uuid(),
    "name"               TEXT          NOT NULL,
    "description"        TEXT,
    "systemInstructions" TEXT,
    "createdAt"          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_conversations" (
    "id"        UUID          NOT NULL DEFAULT gen_random_uuid(),
    "projectId" UUID,
    "title"     TEXT,
    "model"     TEXT,
    "archived"  BOOLEAN       NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_messages" (
    "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),
    "conversationId" UUID          NOT NULL,
    "role"           TEXT          NOT NULL,
    "content"        JSONB         NOT NULL,
    "tokensIn"       INTEGER,
    "tokensOut"      INTEGER,
    "costUsd"        DECIMAL(10,6),
    "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_artifacts" (
    "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),
    "conversationId" UUID          NOT NULL,
    "messageId"      UUID,
    "type"           TEXT,
    "title"          TEXT,
    "content"        TEXT,
    "version"        INTEGER       NOT NULL DEFAULT 1,
    "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_memory" (
    "id"        UUID          NOT NULL DEFAULT gen_random_uuid(),
    "scope"     TEXT          NOT NULL,
    "key"       TEXT,
    "content"   TEXT          NOT NULL,
    "pinned"    BOOLEAN       NOT NULL DEFAULT false,
    "metadata"  JSONB,
    "createdAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_memory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_tool_calls" (
    "id"         UUID          NOT NULL DEFAULT gen_random_uuid(),
    "messageId"  UUID,
    "toolName"   TEXT          NOT NULL,
    "input"      JSONB,
    "output"     JSONB,
    "status"     TEXT,
    "durationMs" INTEGER,
    "error"      TEXT,
    "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_tool_calls_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "agent_conversations"
    ADD CONSTRAINT "agent_conversations_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "agent_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_messages"
    ADD CONSTRAINT "agent_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_artifacts"
    ADD CONSTRAINT "agent_artifacts_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_artifacts"
    ADD CONSTRAINT "agent_artifacts_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "agent_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_tool_calls"
    ADD CONSTRAINT "agent_tool_calls_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "agent_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes (all FK columns + composite query patterns)
CREATE INDEX "agent_conversations_projectId_idx"            ON "agent_conversations"("projectId");
CREATE INDEX "agent_conversations_updatedAt_idx"            ON "agent_conversations"("updatedAt" DESC);
CREATE INDEX "agent_messages_conversationId_createdAt_idx"  ON "agent_messages"("conversationId", "createdAt");
CREATE INDEX "agent_artifacts_conversationId_idx"           ON "agent_artifacts"("conversationId");
CREATE INDEX "agent_artifacts_messageId_idx"                ON "agent_artifacts"("messageId");
CREATE INDEX "agent_memory_scope_idx"                       ON "agent_memory"("scope");
CREATE INDEX "agent_tool_calls_messageId_idx"               ON "agent_tool_calls"("messageId");

-- Seed: three default projects (idempotent — skips if name already exists)
INSERT INTO "agent_projects" ("id", "name", "description", "createdAt", "updatedAt")
SELECT gen_random_uuid(), v.name, v.description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
    ('ALMA Lifestyle', 'ALMA Lifestyle business operations'),
    ('ALMA Trading',   'ALMA Trading business operations'),
    ('Personal',       'Personal tasks and management')
) AS v(name, description)
WHERE NOT EXISTS (
    SELECT 1 FROM "agent_projects" WHERE "name" = v.name
);
