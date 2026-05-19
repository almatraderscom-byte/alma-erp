CREATE INDEX IF NOT EXISTS "Notification_businessId_type_createdAt_idx" ON "Notification"("businessId", "type", "createdAt");
CREATE INDEX IF NOT EXISTS "NotificationRecipient_userId_businessId_createdAt_idx" ON "NotificationRecipient"("userId", "businessId", "createdAt");
CREATE INDEX IF NOT EXISTS "ApprovalRequest_requestedBy_status_createdAt_idx" ON "ApprovalRequest"("requestedBy", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingTrade_businessId_deletedAt_createdAt_idx" ON "TradingTrade"("businessId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingExpense_businessId_deletedAt_createdAt_idx" ON "TradingExpense"("businessId", "deletedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "TradingCapitalEntry_businessId_deletedAt_createdAt_idx" ON "TradingCapitalEntry"("businessId", "deletedAt", "createdAt");
