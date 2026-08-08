-- Re-run the safe legacy appeal backfill for rows created after the original
-- migration. Ambiguous same-amount fine days deliberately remain unlinked.
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
UPDATE "AttendanceWaiverRequest" waiver
SET "penaltyLedgerEntryId" = linked."ledgerEntryId",
    "updatedAt" = NOW()
FROM "unique_links" linked
WHERE waiver."id" = linked."waiverId"
  AND waiver."penaltyLedgerEntryId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "AttendanceWaiverRequest" existing
    WHERE existing."userId" = waiver."userId"
      AND existing."penaltyLedgerEntryId" = linked."ledgerEntryId"
      AND existing."id" <> waiver."id"
  );

-- Complete the immutable fine -> appeal -> refund chain for legacy approved
-- appeals. Only deterministic, already-linked waiver/fine pairs are touched.
UPDATE "EmployeeLedgerEntry" refund
SET "relatedEntryId" = waiver."penaltyLedgerEntryId",
    "updatedAt" = NOW()
FROM "AttendanceWaiverRequest" waiver
JOIN "EmployeeLedgerEntry" fine
  ON fine."id" = waiver."penaltyLedgerEntryId"
 AND fine."employeeId" = waiver."employeeId"
 AND fine."businessId" = waiver."businessId"
 AND fine."type" = 'PENALTY'
WHERE refund."id" = waiver."reversalLedgerEntryId"
  AND waiver."penaltyLedgerEntryId" IS NOT NULL
  AND refund."relatedEntryId" IS NULL
  AND refund."employeeId" = waiver."employeeId"
  AND refund."businessId" = waiver."businessId"
  AND refund."type" = 'ADJUSTMENT'
  AND refund."source" = 'attendance_late_penalty_reversal';
