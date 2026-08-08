-- Final legacy combined-appeal signature: old code stored original, requested,
-- approved, and refund amounts as late + no-checkout, while linking the appeal
-- to the late ledger row. Split that exact decision without changing balance.

WITH "combined" AS (
  SELECT
    waiver."id" AS "waiverId",
    waiver."reversalLedgerEntryId",
    ABS(late_fine."amount") AS "lateAmount",
    ABS(no_checkout_fine."amount") AS "noCheckoutAmount",
    no_checkout_fine."id" AS "noCheckoutLedgerEntryId"
  FROM "AttendanceWaiverRequest" waiver
  JOIN "AttendanceRecord" record ON record."id" = waiver."attendanceRecordId"
  JOIN "EmployeeLedgerEntry" late_fine
    ON late_fine."id" = record."penaltyLedgerEntryId"
   AND late_fine."id" = waiver."penaltyLedgerEntryId"
   AND late_fine."employeeId" = waiver."employeeId"
   AND late_fine."businessId" = waiver."businessId"
   AND late_fine."type" = 'PENALTY'
   AND late_fine."source" = 'attendance_late_penalty'
   AND late_fine."isArchived" = FALSE
  JOIN "EmployeeLedgerEntry" no_checkout_fine
    ON no_checkout_fine."id" = record."noCheckoutFineLedgerEntryId"
   AND no_checkout_fine."employeeId" = waiver."employeeId"
   AND no_checkout_fine."businessId" = waiver."businessId"
   AND no_checkout_fine."type" = 'PENALTY'
   AND no_checkout_fine."source" = 'attendance_no_checkout_fine'
   AND no_checkout_fine."isArchived" = FALSE
  JOIN "EmployeeLedgerEntry" refund
    ON refund."id" = waiver."reversalLedgerEntryId"
   AND refund."employeeId" = waiver."employeeId"
   AND refund."businessId" = waiver."businessId"
  WHERE waiver."status" IN ('APPROVED', 'PARTIALLY_APPROVED')
    AND waiver."originalPenaltyAmount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
    AND waiver."requestedReductionAmount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
    AND waiver."approvedReductionAmount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
    AND refund."type" = 'ADJUSTMENT'
    AND refund."source" = 'attendance_late_penalty_reversal'
    AND refund."relatedEntryId" = late_fine."id"
    AND refund."amount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
    AND NOT EXISTS (
      SELECT 1 FROM "AttendanceWaiverRequest" existing
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
  'legacy_combined_refund_' || combined."waiverId",
  refund."employeeId", refund."userId", refund."businessId", refund."date", refund."periodYm",
  refund."type", combined."noCheckoutAmount",
  CONCAT(COALESCE(refund."note", 'Attendance penalty appeal refund'), ' · no-checkout portion'),
  refund."createdById", refund."approvedById", refund."source",
  'legacy_combined_no_checkout:' || combined."waiverId",
  refund."walletRequestId", combined."noCheckoutLedgerEntryId", refund."isArchived",
  refund."archivedAt", refund."archivedById", refund."archiveBatchId",
  refund."createdAt" + INTERVAL '1 millisecond', NOW()
FROM "combined" combined
JOIN "EmployeeLedgerEntry" refund ON refund."id" = combined."reversalLedgerEntryId"
WHERE NOT EXISTS (
  SELECT 1 FROM "EmployeeLedgerEntry" existing
  WHERE existing."id" = 'legacy_combined_refund_' || combined."waiverId"
);

WITH "combined" AS (
  SELECT
    waiver.*,
    ABS(late_fine."amount") AS "lateAmount",
    ABS(no_checkout_fine."amount") AS "noCheckoutAmount",
    no_checkout_fine."id" AS "noCheckoutLedgerEntryId"
  FROM "AttendanceWaiverRequest" waiver
  JOIN "AttendanceRecord" record ON record."id" = waiver."attendanceRecordId"
  JOIN "EmployeeLedgerEntry" late_fine
    ON late_fine."id" = waiver."penaltyLedgerEntryId"
   AND late_fine."id" = record."penaltyLedgerEntryId"
  JOIN "EmployeeLedgerEntry" no_checkout_fine
    ON no_checkout_fine."id" = record."noCheckoutFineLedgerEntryId"
  JOIN "EmployeeLedgerEntry" split_refund
    ON split_refund."id" = 'legacy_combined_refund_' || waiver."id"
   AND split_refund."relatedEntryId" = no_checkout_fine."id"
  WHERE waiver."status" IN ('APPROVED', 'PARTIALLY_APPROVED')
    AND waiver."originalPenaltyAmount" = ABS(late_fine."amount") + ABS(no_checkout_fine."amount")
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
  'legacy_combined_no_checkout_' || combined."id",
  combined."attendanceRecordId", combined."businessId", combined."userId", combined."employeeId",
  combined."status", combined."requestType", combined."noCheckoutAmount",
  combined."noCheckoutAmount", combined."noCheckoutAmount", combined."reason",
  combined."attachmentDataUrl",
  CONCAT_WS(E'\n', NULLIF(combined."adminNote", ''), '[System] Legacy combined review split: no-checkout fine decision.'),
  combined."reviewedById", combined."reviewedAt",
  'legacy_combined_refund_' || combined."id", combined."noCheckoutLedgerEntryId",
  combined."isArchived", combined."archivedAt", combined."archivedById", combined."archiveBatchId",
  combined."createdAt" + INTERVAL '1 millisecond', NOW()
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
  ON split_waiver."id" = 'legacy_combined_no_checkout_' || waiver."id"
WHERE refund."id" = waiver."reversalLedgerEntryId"
  AND late_fine."source" = 'attendance_late_penalty';

UPDATE "AttendanceWaiverRequest" waiver
SET "originalPenaltyAmount" = ABS(late_fine."amount"),
    "requestedReductionAmount" = ABS(late_fine."amount"),
    "approvedReductionAmount" = ABS(late_fine."amount"),
    "adminNote" = CONCAT_WS(E'\n', NULLIF(waiver."adminNote", ''), '[System] Legacy combined review split: late-check-in fine decision.'),
    "updatedAt" = NOW()
FROM "EmployeeLedgerEntry" late_fine
JOIN "AttendanceWaiverRequest" split_waiver
  ON split_waiver."id" LIKE 'legacy_combined_no_checkout_%'
WHERE waiver."id" = SUBSTRING(split_waiver."id" FROM LENGTH('legacy_combined_no_checkout_') + 1)
  AND waiver."penaltyLedgerEntryId" = late_fine."id"
  AND late_fine."source" = 'attendance_late_penalty';
