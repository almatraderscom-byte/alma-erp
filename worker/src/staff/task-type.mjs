/** Must match staff_tasks_type_check in Postgres. */
const ALLOWED_STAFF_TASK_TYPES = new Set([
  'ad_creative', 'product_content', 'product_photo', 'video_reel', 'listing_update',
  'order_followup', 'page_management', 'customer_reply', 'content_support', 'office_task',
  'stock_check', 'misc', 'strategist_directive',
])

export function normalizeStaffTaskType(type) {
  const t = String(type ?? 'misc').trim()
  if (t === 'general') return 'misc'
  return ALLOWED_STAFF_TASK_TYPES.has(t) ? t : 'misc'
}
