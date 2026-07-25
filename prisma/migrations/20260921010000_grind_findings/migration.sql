-- Grind engine (S1) — the durable findings store.
--
-- A campaign ("fix all 246 issues") is one AgentFindingSet; every individual
-- problem is one AgentFinding, identified by a FINGERPRINT that is byte-identical
-- to the key the before/after report already uses (`${scope}|${code}` in
-- seo-report.ts). Identical keys are what let the store and the client-facing
-- comparison agree by construction instead of by hope.
--
-- The status column is the whole safety model:
--   open | in_progress | fix_claimed | fixed | regressed | needs_rediagnosis | wont_fix
-- Only the deterministic step-verifier may write 'fixed'. A model's opinion can
-- reach at most 'fix_claimed', which the end-of-campaign re-measurement must
-- confirm — so "done" is arithmetic, not a claim.
--
-- Additive only; nothing reads these tables until the grind engine is switched on.

CREATE TABLE IF NOT EXISTS "agent_finding_sets" (
  "id"              TEXT NOT NULL,
  "business_id"     TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',
  "source"          TEXT NOT NULL,
  "target"          TEXT NOT NULL,
  "label"           TEXT,
  "status"          TEXT NOT NULL DEFAULT 'open',
  "plan_id"         TEXT,
  "conversation_id" TEXT,
  "baseline_ref"    TEXT,
  "halt_reason"     TEXT,
  "regression_count" INTEGER NOT NULL DEFAULT 0,
  "last_measured_at" TIMESTAMP(3),
  "last_fix_at"      TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_finding_sets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_finding_sets_status_idx" ON "agent_finding_sets"("status");
CREATE INDEX IF NOT EXISTS "agent_finding_sets_plan_idx"   ON "agent_finding_sets"("plan_id");

CREATE TABLE IF NOT EXISTS "agent_findings" (
  "id"             TEXT NOT NULL,
  "set_id"         TEXT NOT NULL,
  "fingerprint"    TEXT NOT NULL,
  "scope"          TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "family"         TEXT NOT NULL,
  "severity"       TEXT NOT NULL,
  "detail"         TEXT,
  "status"         TEXT NOT NULL DEFAULT 'open',
  "root_cause"     TEXT,
  "root_cause_ref" TEXT,
  "batch_key"      TEXT,
  "step_id"        TEXT,
  "note"           TEXT,
  "introduced"     BOOLEAN NOT NULL DEFAULT false,
  "first_seen_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"   TIMESTAMP(3),
  "re_measured_at" TIMESTAMP(3),
  "fixed_at"       TIMESTAMP(3),
  CONSTRAINT "agent_findings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_findings_set_id_fkey" FOREIGN KEY ("set_id")
    REFERENCES "agent_finding_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_findings_set_fingerprint_key" ON "agent_findings"("set_id", "fingerprint");
CREATE INDEX IF NOT EXISTS "agent_findings_set_status_idx" ON "agent_findings"("set_id", "status");
CREATE INDEX IF NOT EXISTS "agent_findings_set_family_idx" ON "agent_findings"("set_id", "family");
