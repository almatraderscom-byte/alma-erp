-- Backfill only when exactly one posted fine on the attendance record matches
-- the appeal amount. Ambiguous legacy rows remain null for manual review.
WITH "candidate_links" AS (
  SELECT w."id" AS "waiverId", r."penaltyLedgerEntryId" AS "ledgerEntryId"
  FROM "AttendanceWaiverRequest" w
  JOIN "AttendanceRecord" r ON r."id" = w."attendanceRecordId"
  WHERE w."penaltyLedgerEntryId" IS NULL
    AND r."penaltyLedgerEntryId" IS NOT NULL
    AND r."penaltyAmount" = w."originalPenaltyAmount"

  UNION ALL

  SELECT w."id", r."earlyLeavePenaltyLedgerEntryId"
  FROM "AttendanceWaiverRequest" w
  JOIN "AttendanceRecord" r ON r."id" = w."attendanceRecordId"
  WHERE w."penaltyLedgerEntryId" IS NULL
    AND r."earlyLeavePenaltyLedgerEntryId" IS NOT NULL
    AND r."earlyLeavePenaltyAmount" = w."originalPenaltyAmount"

  UNION ALL

  SELECT w."id", r."noCheckoutFineLedgerEntryId"
  FROM "AttendanceWaiverRequest" w
  JOIN "AttendanceRecord" r ON r."id" = w."attendanceRecordId"
  WHERE w."penaltyLedgerEntryId" IS NULL
    AND r."noCheckoutFineLedgerEntryId" IS NOT NULL
    AND r."noCheckoutFineAmount" = w."originalPenaltyAmount"
),
"unique_links" AS (
  SELECT "waiverId", MIN("ledgerEntryId") AS "ledgerEntryId"
  FROM "candidate_links"
  GROUP BY "waiverId"
  HAVING COUNT(*) = 1
)
UPDATE "AttendanceWaiverRequest" w
SET "penaltyLedgerEntryId" = u."ledgerEntryId",
    "updatedAt" = NOW()
FROM "unique_links" u
WHERE w."id" = u."waiverId"
  AND w."penaltyLedgerEntryId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "AttendanceWaiverRequest" existing
    WHERE existing."userId" = w."userId"
      AND existing."penaltyLedgerEntryId" = u."ledgerEntryId"
      AND existing."id" <> w."id"
  );
