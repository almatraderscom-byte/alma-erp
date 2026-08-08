-- Older review code could approve a late-check-in fine and the same record's
-- no-checkout fine as one combined appeal/refund. Preserve the wallet total and
-- reviewer audit, but split that historical decision into two exact chains:
--   late fine -> late appeal -> late refund
--   no-checkout fine -> no-checkout appeal -> no-checkout refund
--
-- The predicates are intentionally strict. A row is repaired only when the
-- approved/requested/refund amount equals late + no-checkout exactly and no
-- separate no-checkout appeal exists yet.

WITH "combined" AS (
  SELECT
    waiver."id" AS "waiverId",
    waiver."userId",
    waiver."employeeId",
    waiver."businessId",
    waiver."reversalLedgerEntryId",
    record."penaltyAmount" AS "lateAmount",
    record."noCheckoutFineAmount" AS "noCheckoutAmount",
    record."noCheckoutFineLedgerEntryId" AS "noCheckoutLedgerEntryId"
  FROM "AttendanceWaiverRequest" waiver
  JOIN "AttendanceRecord" record
    ON record."id" = waiver."attendanceRecordId"
  JOIN "EmployeeLedgerEntry" refund
    ON refund."id" = waiver."reversalLedgerEntryId"
   AND refund."employeeId" = waiver."employeeId"
   AND refund."businessId" = waiver."businessId"
  WHERE waiver."status" IN ('APPROVED', 'PARTIALLY_APPROVED')
    AND waiver."penaltyLedgerEntryId" = record."penaltyLedgerEntryId"
    AND record."penaltyLedgerEntryId" IS NOT NULL
    AND record."noCheckoutFineLedgerEntryId" IS NOT NULL
    AND record."penaltyAmount" > 0
    AND record."noCheckoutFineAmount" > 0
    AND waiver."originalPenaltyAmount" = record."penaltyAmount"
    AND waiver."requestedReductionAmount" = record."penaltyAmount" + record."noCheckoutFineAmount"
    AND waiver."approvedReductionAmount" = record."penaltyAmount" + record."noCheckoutFineAmount"
    AND refund."type" = 'ADJUSTMENT'
    AND refund."source" = 'attendance_late_penalty_reversal'
    AND refund."relatedEntryId" = record."penaltyLedgerEntryId"
    AND refund."amount" = record."penaltyAmount" + record."noCheckoutFineAmount"
    AND NOT EXISTS (
      SELECT 1
      FROM "AttendanceWaiverRequest" existing
      WHERE existing."userId" = waiver."userId"
        AND existing."penaltyLedgerEntryId" = record."noCheckoutFineLedgerEntryId"
    )
)
INSERT INTO "EmployeeLedgerEntry" (
  "id", "employeeId", "userId", "businessId", "date", "periodYm", "type", "amount",
  "note", "createdById", "approvedById", "source", "sourceRef", "walletRequestId",
  "relatedEntryId", "isArchived", "archivedAt", "archivedById", "archiveBatchId",
  "createdAt", "updatedAt"
)
SELECT
  'legacy_split_refund_' || combined."waiverId",
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
  'legacy_split_no_checkout:' || combined."waiverId",
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
  WHERE existing."id" = 'legacy_split_refund_' || combined."waiverId"
);

WITH "combined" AS (
  SELECT
    waiver.*,
    record."penaltyAmount" AS "lateAmount",
    record."noCheckoutFineAmount" AS "noCheckoutAmount",
    record."noCheckoutFineLedgerEntryId" AS "noCheckoutLedgerEntryId"
  FROM "AttendanceWaiverRequest" waiver
  JOIN "AttendanceRecord" record ON record."id" = waiver."attendanceRecordId"
  JOIN "EmployeeLedgerEntry" split_refund
    ON split_refund."id" = 'legacy_split_refund_' || waiver."id"
   AND split_refund."relatedEntryId" = record."noCheckoutFineLedgerEntryId"
  WHERE waiver."status" IN ('APPROVED', 'PARTIALLY_APPROVED')
    AND waiver."penaltyLedgerEntryId" = record."penaltyLedgerEntryId"
    AND waiver."originalPenaltyAmount" = record."penaltyAmount"
    AND waiver."requestedReductionAmount" = record."penaltyAmount" + record."noCheckoutFineAmount"
    AND waiver."approvedReductionAmount" = record."penaltyAmount" + record."noCheckoutFineAmount"
)
INSERT INTO "AttendanceWaiverRequest" (
  "id", "attendanceRecordId", "businessId", "userId", "employeeId", "status", "requestType",
  "originalPenaltyAmount", "requestedReductionAmount", "approvedReductionAmount", "reason",
  "attachmentDataUrl", "adminNote", "reviewedById", "reviewedAt", "reversalLedgerEntryId",
  "penaltyLedgerEntryId", "isArchived", "archivedAt", "archivedById", "archiveBatchId",
  "createdAt", "updatedAt"
)
SELECT
  'legacy_split_no_checkout_' || combined."id",
  combined."attendanceRecordId",
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
  'legacy_split_refund_' || combined."id",
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

-- Reduce the original refund to the late-check-in portion. The new refund row
-- carries the no-checkout portion, so the employee's wallet balance is unchanged.
UPDATE "EmployeeLedgerEntry" refund
SET "amount" = record."penaltyAmount",
    "note" = CONCAT(COALESCE(refund."note", 'Attendance penalty appeal refund'), ' · late-check-in portion'),
    "updatedAt" = NOW()
FROM "AttendanceWaiverRequest" waiver
JOIN "AttendanceRecord" record ON record."id" = waiver."attendanceRecordId"
JOIN "AttendanceWaiverRequest" split_waiver
  ON split_waiver."id" = 'legacy_split_no_checkout_' || waiver."id"
 AND split_waiver."penaltyLedgerEntryId" = record."noCheckoutFineLedgerEntryId"
WHERE refund."id" = waiver."reversalLedgerEntryId"
  AND waiver."penaltyLedgerEntryId" = record."penaltyLedgerEntryId";

-- The original appeal now represents the exact late-check-in fine only.
UPDATE "AttendanceWaiverRequest" waiver
SET "requestedReductionAmount" = record."penaltyAmount",
    "approvedReductionAmount" = record."penaltyAmount",
    "adminNote" = CONCAT_WS(E'\n', NULLIF(waiver."adminNote", ''), '[System] Legacy combined review split: late-check-in fine decision.'),
    "updatedAt" = NOW()
FROM "AttendanceRecord" record
JOIN "AttendanceWaiverRequest" split_waiver
  ON split_waiver."attendanceRecordId" = record."id"
 AND split_waiver."id" LIKE 'legacy_split_no_checkout_%'
 AND split_waiver."penaltyLedgerEntryId" = record."noCheckoutFineLedgerEntryId"
WHERE waiver."id" = SUBSTRING(split_waiver."id" FROM LENGTH('legacy_split_no_checkout_') + 1)
  AND waiver."attendanceRecordId" = record."id"
  AND waiver."penaltyLedgerEntryId" = record."penaltyLedgerEntryId";
