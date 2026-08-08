-- Existing installations can have an explicit SMS type allow-list that predates
-- penalty appeal result messages. Add the new type once so the feature works
-- immediately; future administrator changes remain authoritative.
UPDATE "SmsSetting"
SET
  "enabledTypesJson" = (
    "enabledTypesJson"::jsonb || '["PENALTY_APPEAL_REVIEWED"]'::jsonb
  )::text,
  "updatedAt" = NOW()
WHERE "enabledTypesJson" IS NOT NULL
  AND BTRIM("enabledTypesJson") <> ''
  AND jsonb_typeof("enabledTypesJson"::jsonb) = 'array'
  AND NOT ("enabledTypesJson"::jsonb ? 'PENALTY_APPEAL_REVIEWED');
