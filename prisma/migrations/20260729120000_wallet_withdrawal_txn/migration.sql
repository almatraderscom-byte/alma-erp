-- Wallet withdrawal evidence: store the owner-entered transaction reference
-- (bKash/bank/etc.) captured at approval time, so the staff SMS can include it.
-- Additive, nullable — no impact on existing rows or wallet financial logic.
ALTER TABLE "WalletRequest" ADD COLUMN IF NOT EXISTS "transactionId" TEXT;
