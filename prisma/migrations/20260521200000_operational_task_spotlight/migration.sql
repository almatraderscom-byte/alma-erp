-- Operational Task Spotlight
CREATE TYPE "OperationalTaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');
CREATE TYPE "OperationalTaskStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "OperationalAssignmentStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'ARCHIVED');
CREATE TYPE "OperationalTaskAckAction" AS ENUM ('ASSIGNED', 'ACKNOWLEDGED', 'STARTED', 'COMPLETED', 'DISMISSED', 'EXPIRED', 'ARCHIVED');

CREATE TABLE "OperationalTask" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "OperationalTaskPriority" NOT NULL DEFAULT 'NORMAL',
    "bannerImageUrl" TEXT,
    "deadline" TIMESTAMP(3),
    "acknowledgmentRequired" BOOLEAN NOT NULL DEFAULT true,
    "allowDismiss" BOOLEAN NOT NULL DEFAULT false,
    "showOnCheckIn" BOOLEAN NOT NULL DEFAULT true,
    "status" "OperationalTaskStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalTaskAssignment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeIdGas" TEXT,
    "status" "OperationalAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "acknowledgedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "lastSpotlightAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalTaskAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalTaskAcknowledgement" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "OperationalTaskAckAction" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalTaskAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperationalTaskAssignment_taskId_userId_key" ON "OperationalTaskAssignment"("taskId", "userId");
CREATE INDEX "OperationalTask_status_createdAt_idx" ON "OperationalTask"("status", "createdAt");
CREATE INDEX "OperationalTaskAssignment_userId_status_idx" ON "OperationalTaskAssignment"("userId", "status");
CREATE INDEX "OperationalTaskAssignment_taskId_status_idx" ON "OperationalTaskAssignment"("taskId", "status");
CREATE INDEX "OperationalTaskAcknowledgement_assignmentId_createdAt_idx" ON "OperationalTaskAcknowledgement"("assignmentId", "createdAt");

ALTER TABLE "OperationalTaskAssignment" ADD CONSTRAINT "OperationalTaskAssignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OperationalTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OperationalTaskAcknowledgement" ADD CONSTRAINT "OperationalTaskAcknowledgement_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "OperationalTaskAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "TelegramNotificationEventType" ADD VALUE 'OPERATIONAL_TASK_ASSIGNED';
ALTER TYPE "TelegramNotificationEventType" ADD VALUE 'OPERATIONAL_TASK_UPDATED';
