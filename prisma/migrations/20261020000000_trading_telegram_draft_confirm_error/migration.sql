-- Telegram quick-entry confirm→ledger used to strand a draft: the row was flipped
-- to APPROVED BEFORE the trade was written, so any ledger guard (e.g. "sell more
-- USDT than the account holds") left it APPROVED forever — invisible in the
-- PENDING list, never in the account, with no button to retry.
--
-- The confirm is atomic now and rolls back to PENDING on failure. These two
-- columns keep the REASON with the draft so staff see it on the card instead of
-- a toast that already vanished.
--
-- Additive + nullable: NULL = never failed, which is every existing row.
ALTER TABLE "TradingTelegramDraft" ADD COLUMN IF NOT EXISTS "confirmError" TEXT;
ALTER TABLE "TradingTelegramDraft" ADD COLUMN IF NOT EXISTS "confirmErrorAt" TIMESTAMP(3);
