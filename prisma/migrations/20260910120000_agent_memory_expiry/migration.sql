-- Additive: temporary/day-scoped memories carry an expiry; NULL = permanent.
ALTER TABLE "agent_memory" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
