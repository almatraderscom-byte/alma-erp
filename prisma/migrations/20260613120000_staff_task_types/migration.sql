-- Extend staff_tasks.type check for profile-based task skills (Phase 6 worker).
ALTER TABLE staff_tasks DROP CONSTRAINT IF EXISTS staff_tasks_type_check;
ALTER TABLE staff_tasks ADD CONSTRAINT staff_tasks_type_check CHECK (type IN (
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
  'misc'
));
