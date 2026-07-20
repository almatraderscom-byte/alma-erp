-- G09 / SPEC-081 — PROPOSED (NOT APPLIED) durable capability catalog table.
--
-- This migration is INTENTIONALLY NOT wired into the live migration system.
-- Per the standing G09 decision, the group does not touch prisma/schema.prisma
-- and runs no migration on the live DB. The runtime uses the in-memory
-- CapabilityStore (store.ts) seeded from the generated catalog; this file is the
-- proposed additive schema for when a durable store is adopted by the integration
-- session with owner sign-off.
--
-- Additive only. Reversible: DROP TABLE "AgentCapability" restores the prior DB.

CREATE TABLE IF NOT EXISTS "AgentCapability" (
  "id"            TEXT PRIMARY KEY,                 -- cap.<key>
  "key"           TEXT NOT NULL UNIQUE,             -- domain key
  "title"         TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'active',   -- active|preview|disabled
  "intents"       JSONB NOT NULL DEFAULT '[]',      -- string[]
  "intentClasses" JSONB NOT NULL DEFAULT '[]',      -- G02 IntentClass[]
  "toolNames"     JSONB NOT NULL DEFAULT '[]',      -- G08 tool names
  "permission"    JSONB NOT NULL,                   -- { scope, minRole, defaultDecision }
  "cost"          JSONB NOT NULL,                   -- { tier, class }
  "runtime"       JSONB NOT NULL,                   -- { groups, pools }
  "owner"         JSONB NOT NULL,                   -- { team, zonePrefix }
  "health"        JSONB NOT NULL,                   -- { status, killSwitch, reason? }
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "AgentCapability_status_idx" ON "AgentCapability" ("status");

-- Rollback:
--   DROP INDEX IF EXISTS "AgentCapability_status_idx";
--   DROP TABLE IF EXISTS "AgentCapability";
