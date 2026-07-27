-- Who actually decided this? (owner caught the card lying, 2026-07-27)
--
-- The settled card said "আপনি অনুমোদন করেছিলেন" for an SEO audit he had never
-- seen. The first attempt at a signal used resolvedAt — wrong: the worker's
-- job-result route stamps resolvedAt when the JOB finishes, so it means
-- "settled", not "he said yes".
--
-- There is no way to infer this from the existing columns, so it gets its own.
-- Only the approve/reject routes set it, and both refuse any row that is not
-- 'pending' — so a row created already-approved (a read-only crawl, a queued
-- generation) can never pass through them and can never be marked his.
--
-- NULL = unknown provenance; the UI keeps the old wording there, so nothing
-- regresses silently for history written before this column existed.
ALTER TABLE "agent_pending_actions"
  ADD COLUMN IF NOT EXISTS "owner_decided" BOOLEAN;

-- One safe backfill: seo_audit rows are created with status 'approved' by
-- run_website_seo_audit (a read-only crawl needs no card) and therefore never
-- reached him. This is the exact row he pointed at.
UPDATE "agent_pending_actions"
  SET "owner_decided" = FALSE
  WHERE "type" = 'seo_audit' AND "owner_decided" IS NULL;
