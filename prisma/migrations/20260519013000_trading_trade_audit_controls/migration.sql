ALTER TABLE "TradingTrade" ADD COLUMN "deletedBy" TEXT;
ALTER TABLE "TradingTrade" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "TradingTrade" ADD COLUMN "deleteApprovedBy" TEXT;
ALTER TABLE "TradingTrade" ADD COLUMN "deleteApprovedAt" TIMESTAMP(3);
ALTER TABLE "TradingTrade" ADD COLUMN "editHistory" JSONB;
ALTER TABLE "TradingTrade" ADD COLUMN "updatedBy" TEXT;

CREATE INDEX "TradingTrade_deletedAt_deleteApprovedAt_idx" ON "TradingTrade"("deletedAt", "deleteApprovedAt");
CREATE INDEX "TradingTrade_updatedBy_idx" ON "TradingTrade"("updatedBy");
CREATE INDEX "TradingTrade_deletedBy_idx" ON "TradingTrade"("deletedBy");
