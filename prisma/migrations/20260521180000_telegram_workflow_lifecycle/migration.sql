-- Workflow lifecycle Telegram alerts (approve / reject / submit)
ALTER TYPE "TelegramNotificationEventType" ADD VALUE 'WORKFLOW_SUBMITTED';
ALTER TYPE "TelegramNotificationEventType" ADD VALUE 'WORKFLOW_APPROVED';
ALTER TYPE "TelegramNotificationEventType" ADD VALUE 'WORKFLOW_REJECTED';

ALTER TABLE "TelegramOpsSetting" ADD COLUMN "alertWorkflowLifecycle" BOOLEAN NOT NULL DEFAULT true;
