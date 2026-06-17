-- Production stability: duty log UUID default + staff task type for strategist directives

-- Belt-and-suspenders: worker inserts always pass UUID, but DB default prevents silent failures.
ALTER TABLE "agent_duty_log"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- Evening proposal inserts strategist_directive tasks — must match check constraint.
ALTER TABLE "staff_tasks" DROP CONSTRAINT IF EXISTS "staff_tasks_type_check";
ALTER TABLE "staff_tasks" ADD CONSTRAINT "staff_tasks_type_check" CHECK (type IN (
  'ad_creative',
  'product_content',
  'product_photo',
  'video_reel',
  'listing_update',
  'order_followup',
  'page_management',
  'customer_reply',
  'content_support',
  'office_task',
  'stock_check',
  'misc',
  'strategist_directive'
));
