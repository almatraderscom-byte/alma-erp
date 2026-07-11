-- Withdrawal/advance approvals record the disbursement channel (additive)
ALTER TABLE "WalletRequest" ADD COLUMN "paidVia" TEXT;
