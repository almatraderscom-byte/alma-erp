-- The backfill that the previous migration was supposed to carry.
--
-- 20261017000000 shipped to the shared database from a PREVIEW deploy BEFORE the
-- backfill line was added to it. Prisma had already recorded that migration as
-- applied, so editing the file changed nothing: production ended up with
-- last_read_at NULL on every row, and the first badge read reported 958 unread.
--
-- Same intent as before: everything that exists right now counts as read, so only
-- replies written from here on can make a chat unread.
UPDATE "agent_conversations" SET "last_read_at" = NOW() WHERE "last_read_at" IS NULL;
