-- An admin reopening an auto-locked Telegram draft only flipped its status back
-- to PENDING; `createdAt` still pointed at the earlier day. So the cutoff sweep
-- re-locked it on the very next list load, and the confirm claim (which carries
-- the same day rule, atomically) refused it — the advertised admin-reopen
-- recovery could never actually post a locked draft.
--
-- This marks the row as deliberately reopened, which exempts it from both.
--
-- Additive + nullable: NULL = never reopened, which is every existing row.
ALTER TABLE "TradingTelegramDraft" ADD COLUMN IF NOT EXISTS "reopenedAt" TIMESTAMP(3);
