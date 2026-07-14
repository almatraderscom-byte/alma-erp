-- Roadmap Phase 0 (AGENT-ARCH-001): stamp every turn with the behavior-artifact
-- versions (prompt / toolManifest / router / workflow) live when it ran, so a
-- wrong outcome traces to the exact revision. Additive only.
ALTER TABLE "agent_turns" ADD COLUMN IF NOT EXISTS "versions" JSONB;
