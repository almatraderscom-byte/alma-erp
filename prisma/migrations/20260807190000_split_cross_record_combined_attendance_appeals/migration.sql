-- Some older same-day fines were stored in separate AttendanceRecord rows even
-- though one legacy appeal/refund combined the late and no-checkout amounts.
-- Repair only deterministic one-late + one-no-checkout days, preserving the
-- employee's total wallet credit and the original reviewer audit.

WITH "combined" AS (
  SELECT
    waiver."id" AS "waiverId",
    waiver."reversalLedgerEntryId",
    ABS(late_fine."amount") AS "lateAmount",
    ABS(no_checkout_fine."amount") AS "noCheckoutAmount",
    no_checkout_fine."id" AS "noCheckoutLedgerEntryId"
  FROM "AttendanceWaiverRequest" waiver
  JOIN "EmployeeLedgerEntry" late_fine
    ON late_fine."id" = waiver."penaltyLedgerEntryId"
   AND late_fine."employeeId" = waiver."employeeId"
   AND late_fine."businessId" = waiver."businessId"
   AND late_fine."type" = 'PENALTY'
   AND late_fine."source" = 'attendance_late_penalty'
  JOIN "EmployeeLedgerEntry" no_checkout_fine
    ON no_checkout_fine."employeeId" = late_fine."employeeId"
   AND no_checkout_fine."businessId" = late_fine."businessId"
   AND no_checkout_fine."type" = 'PENALTY'
   AND no_checkout_fine."source" = 'attendance_no_checkout_fine'
   AND DATE(no_checkout_fine."date") = DATE(late_fine."date")
  JOIN "AttendanceRecord" no_checkout_record
    ON no_checkout_record."noCheckoutFineLedgerEntryId" = no_checkout_fine."id"
  JOIN "EmployeeLedgerEntry" refund
    ON refund."id" = waiver."reversalLedgerEntryId"
   AND refund."employeeId" = waiver."employeeId"
   AND refund."businessId" = waiver."businessId"
  WHERE waiver."status" IN ('APPROVED', 'PARTIALLY_APPROVED')
    AND waiver."originalPenaltyAmount" = ABS(late_fine."amount")
    AND waiver."requestedReductionAmount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
    AND waiver."approvedReductionAmount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
    AND refund."type" = 'ADJUSTMENT'
    AND refund."source" = 'attendance_late_penalty_reversal'
    AND refund."relatedEntryId" = late_fine."id"
    AND refund."amount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
    AND (
      SELECT COUNT(*)
      FROM "EmployeeLedgerEntry" candidate
      WHERE candidate."employeeId" = late_fine."employeeId"
        AND candidate."businessId" = late_fine."businessId"
        AND candidate."type" = 'PENALTY'
        AND candidate."source" = 'attendance_no_checkout_fine'
        AND DATE(candidate."date") = DATE(late_fine."date")
    ) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM "AttendanceWaiverRequest" existing
      WHERE existing."userId" = waiver."userId"
        AND existing."penaltyLedgerEntryId" = no_checkout_fine."id"
    )
)
INSERT INTO "EmployeeLedgerEntry" (
  "id", "employeeId", "userId", "businessId", "date", "periodYm", "type", "amount",
  "note", "createdById", "approvedById", "source", "sourceRef", "walletRequestId",
  "relatedEntryId", "isArchived", "archivedAt", "archivedById", "archiveBatchId",
  "createdAt", "updatedAt"
)
SELECT
  'legacy_cross_refund_' || combined."waiverId",
  refund."employeeId",
  refund."userId",
  refund."businessId",
  refund."date",
  refund."periodYm",
  refund."type",
  combined."noCheckoutAmount",
  CONCAT(COALESCE(refund."note", 'Attendance penalty appeal refund'), ' · no-checkout portion'),
  refund."createdById",
  refund."approvedById",
  refund."source",
  'legacy_cross_no_checkout:' || combined."waiverId",
  refund."walletRequestId",
  combined."noCheckoutLedgerEntryId",
  refund."isArchived",
  refund."archivedAt",
  refund."archivedById",
  refund."archiveBatchId",
  refund."createdAt" + INTERVAL '1 millisecond',
  NOW()
FROM "combined" combined
JOIN "EmployeeLedgerEntry" refund ON refund."id" = combined."reversalLedgerEntryId"
WHERE NOT EXISTS (
  SELECT 1 FROM "EmployeeLedgerEntry" existing
  WHERE existing."id" = 'legacy_cross_refund_' || combined."waiverId"
);

WITH "combined" AS (
  SELECT
    waiver.*,
    ABS(late_fine."amount") AS "lateAmount",
    ABS(no_checkout_fine."amount") AS "noCheckoutAmount",
    no_checkout_fine."id" AS "noCheckoutLedgerEntryId",
    no_checkout_record."id" AS "noCheckoutAttendanceRecordId"
  FROM "AttendanceWaiverRequest" waiver
  JOIN "EmployeeLedgerEntry" late_fine
    ON late_fine."id" = waiver."penaltyLedgerEntryId"
   AND late_fine."source" = 'attendance_late_penalty'
  JOIN "EmployeeLedgerEntry" no_checkout_fine
    ON no_checkout_fine."employeeId" = late_fine."employeeId"
   AND no_checkout_fine."businessId" = late_fine."businessId"
   AND no_checkout_fine."type" = 'PENALTY'
   AND no_checkout_fine."source" = 'attendance_no_checkout_fine'
   AND DATE(no_checkout_fine."date") = DATE(late_fine."date")
  JOIN "AttendanceRecord" no_checkout_record
    ON no_checkout_record."noCheckoutFineLedgerEntryId" = no_checkout_fine."id"
  JOIN "EmployeeLedgerEntry" split_refund
    ON split_refund."id" = 'legacy_cross_refund_' || waiver."id"
   AND split_refund."relatedEntryId" = no_checkout_fine."id"
  WHERE waiver."status" IN ('APPROVED', 'PARTIALLY_APPROVED')
    AND waiver."originalPenaltyAmount" = ABS(late_fine."amount")
    AND waiver."requestedReductionAmount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
    AND waiver."approvedReductionAmount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
)
INSERT INTO "AttendanceWaiverRequest" (
  "id", "attendanceRecordId", "businessId", "userId", "employeeId", "status", "requestType",
  "originalPenaltyAmount", "requestedReductionAmount", "approvedReductionAmount", "reason",
  "attachmentDataUrl", "adminNote", "reviewedById", "reviewedAt", "reversalLedgerEntryId",
  "penaltyLedgerEntryId", "isArchived", "archivedAt", "archivedById", "archiveBatchId",
  "createdAt", "updatedAt"
)
SELECT
  'legacy_cross_no_checkout_' || combined."id",
  combined."noCheckoutAttendanceRecordId",
  combined."businessId",
  combined."userId",
  combined."employeeId",
  combined."status",
  combined."requestType",
  combined."noCheckoutAmount",
  combined."noCheckoutAmount",
  combined."noCheckoutAmount",
  combined."reason",
  combined."attachmentDataUrl",
  CONCAT_WS(E'\n', NULLIF(combined."adminNote", ''), '[System] Legacy combined review split: no-checkout fine decision.'),
  combined."reviewedById",
  combined."reviewedAt",
  'legacy_cross_refund_' || combined."id",
  combined."noCheckoutLedgerEntryId",
  combined."isArchived",
  combined."archivedAt",
  combined."archivedById",
  combined."archiveBatchId",
  combined."createdAt" + INTERVAL '1 millisecond',
  NOW()
FROM "combined" combined
WHERE NOT EXISTS (
  SELECT 1 FROM "AttendanceWaiverRequest" existing
  WHERE existing."userId" = combined."userId"
    AND existing."penaltyLedgerEntryId" = combined."noCheckoutLedgerEntryId"
);

UPDATE "EmployeeLedgerEntry" refund
SET "amount" = ABS(late_fine."amount"),
    "note" = CONCAT(COALESCE(refund."note", 'Attendance penalty appeal refund'), ' · late-check-in portion'),
    "updatedAt" = NOW()
FROM "AttendanceWaiverRequest" waiver
JOIN "EmployeeLedgerEntry" late_fine ON late_fine."id" = waiver."penaltyLedgerEntryId"
JOIN "AttendanceWaiverRequest" split_waiver
  ON split_waiver."id" = 'legacy_cross_no_checkout_' || waiver."id"
WHERE refund."id" = waiver."reversalLedgerEntryId"
  AND late_fine."source" = 'attendance_late_penalty';

UPDATE "AttendanceWaiverRequest" waiver
SET "requestedReductionAmount" = ABS(late_fine."amount"),
    "approvedReductionAmount" = ABS(late_fine."amount"),
    "adminNote" = CONCAT_WS(E'\n', NULLIF(waiver."adminNote", ''), '[System] Legacy combined review split: late-check-in fine decision.'),
    "updatedAt" = NOW()
FROM "EmployeeLedgerEntry" late_fine
JOIN "AttendanceWaiverRequest" split_waiver
  ON split_waiver."id" LIKE 'legacy_cross_no_checkout_%'
WHERE waiver."id" = SUBSTRING(split_waiver."id" FROM LENGTH('legacy_cross_no_checkout_') + 1)
  AND waiver."penaltyLedgerEntryId" = late_fine."id"
  AND late_fine."source" = 'attendance_late_penalty';
