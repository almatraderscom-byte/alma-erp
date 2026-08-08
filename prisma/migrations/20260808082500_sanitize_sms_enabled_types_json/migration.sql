-- Some legacy installations contain malformed text in enabledTypesJson. The
-- application treats that state as "use defaults"; normalize it before the
-- following allow-list migration performs any jsonb casts.
DO $$
DECLARE
  setting RECORD;
  parsed JSONB;
BEGIN
  FOR setting IN
    SELECT "id", "enabledTypesJson"
    FROM "SmsSetting"
    WHERE "enabledTypesJson" IS NOT NULL
      AND BTRIM("enabledTypesJson") <> ''
  LOOP
    BEGIN
      parsed := setting."enabledTypesJson"::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      UPDATE "SmsSetting"
      SET "enabledTypesJson" = NULL, "updatedAt" = NOW()
      WHERE "id" = setting."id";
    END;
  END LOOP;
END $$;
