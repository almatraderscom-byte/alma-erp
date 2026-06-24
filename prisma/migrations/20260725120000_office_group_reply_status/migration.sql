-- Office group chat · agent one-shot reply with owner approval
-- The agent drafts ONE reply to a staff group message; the draft is held as a
-- 'pending' row visible only to the owner, who approves (→ 'posted', shown to
-- everyone) or dismisses (→ 'dismissed', hidden). Normal owner/staff messages
-- are 'posted'. Fully additive + idempotent.

ALTER TABLE "office_group_messages"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'posted';

-- Owner-side lookup of pending drafts; staff feed filters to 'posted'.
CREATE INDEX IF NOT EXISTS "office_group_messages_business_status_idx"
  ON "office_group_messages"("business_id", "status", "created_at" DESC);
