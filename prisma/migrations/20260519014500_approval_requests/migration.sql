CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

CREATE TABLE "ApprovalRequest" (
  "id" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "businessId" TEXT,
  "entityId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "approvedBy" TEXT,
  "rejectedBy" TEXT,
  "reason" TEXT NOT NULL,
  "payloadSnapshot" JSONB,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
  "actionUrl" TEXT,
  "auditHistory" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApprovalRequest_status_createdAt_idx" ON "ApprovalRequest"("status", "createdAt");
CREATE INDEX "ApprovalRequest_module_status_createdAt_idx" ON "ApprovalRequest"("module", "status", "createdAt");
CREATE INDEX "ApprovalRequest_businessId_status_createdAt_idx" ON "ApprovalRequest"("businessId", "status", "createdAt");
CREATE INDEX "ApprovalRequest_priority_status_createdAt_idx" ON "ApprovalRequest"("priority", "status", "createdAt");
CREATE INDEX "ApprovalRequest_entityId_idx" ON "ApprovalRequest"("entityId");
CREATE INDEX "ApprovalRequest_requestedBy_status_idx" ON "ApprovalRequest"("requestedBy", "status");
CREATE INDEX "ApprovalRequest_approvedBy_idx" ON "ApprovalRequest"("approvedBy");
CREATE INDEX "ApprovalRequest_rejectedBy_idx" ON "ApprovalRequest"("rejectedBy");
