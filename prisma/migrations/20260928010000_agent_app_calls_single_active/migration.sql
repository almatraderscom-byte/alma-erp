-- One ACTIVE agent app call at a time, enforced by the database (additive).
-- check-then-create raced when two ringers (salah worker + manual/ladder) hit
-- simultaneously — both passed findFirst, both created, CallKit rejected one.
-- A partial unique index on a constant expression allows at most ONE row that
-- is 'ringing' or 'answered-and-not-ended'; the second INSERT fails and the
-- caller reports 'busy'.

-- Close out any historical rows that would violate the index (keep the newest
-- active row, end the rest — they are long-dead rings/sessions).
UPDATE "agent_app_calls"
SET "status" = CASE WHEN "status" = 'ringing' THEN 'unanswered' ELSE 'completed' END,
    "ended_at" = COALESCE("ended_at", NOW())
WHERE ("status" = 'ringing' OR ("status" = 'answered' AND "ended_at" IS NULL))
  AND "id" <> (
    SELECT "id" FROM "agent_app_calls"
    WHERE "status" = 'ringing' OR ("status" = 'answered' AND "ended_at" IS NULL)
    ORDER BY "created_at" DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX "agent_app_calls_single_active"
ON "agent_app_calls" ((1))
WHERE "status" = 'ringing' OR ("status" = 'answered' AND "ended_at" IS NULL);
